// Regression (R3-H7 / T3-1, T3-1b): a hung upstream stream must end via the
// upstream idle timeout instead of being kept alive forever by heartbeats.
import { describe, it, expect } from "bun:test";
import { setup, chunk, post, readFor } from "./_h";

function stallingBody(first: string) {
  const enc = new TextEncoder();
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(first)); },
    cancel() { state.cancelled = true; },
  });
  return { body, state };
}

for (const path of ["/v1/chat/completions", "/v1/completions"]) {
  describe(`stream upstream idle timeout (${path})`, () => {
    it("ends a stream whose upstream went silent with an error event, no [DONE], upstream cancelled", async () => {
      let st: { cancelled: boolean } | undefined;
      const s = setup(() => {
        const { body, state } = stallingBody(chunk("hel"));
        st = state;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }, { requestTimeout: "1s", server: { sseHeartbeatSeconds: 0.2, streamIdleTimeoutSeconds: 1 } } as never);
      try {
        const extra = path === "/v1/completions" ? { prompt: "hi", messages: undefined } : {};
        const r = await post(s.app, { stream: true, ...extra }, path);
        expect(r.status).toBe(200);
        const { text, ended } = await readFor(r, 4000);
        expect(ended).toBe(true);
        expect(text).toContain("hel");
        expect(text).toContain("stream_idle_timeout");
        expect(text).not.toContain("[DONE]");
        await Bun.sleep(100);
        expect(st!.cancelled).toBe(true);
      } finally { s.stop(); }
    }, 10000);
  });
}

describe("hung stream releases its concurrency slot after the idle timeout", () => {
  it("maxConcurrency=1: a new request succeeds once the hung stream idled out", async () => {
    let n = 0;
    const s = setup(() => {
      n++;
      if (n === 1) return new Response(stallingBody(chunk("hel")).body, { headers: { "content-type": "text/event-stream" } });
      return Response.json({ id: "x", object: "chat.completion", created: 1, model: "gpt-4o", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }, { requestTimeout: "1s", server: { sseHeartbeatSeconds: 0.2, streamIdleTimeoutSeconds: 1 } } as never, { concurrency: { maxConcurrency: 1, queueSize: 0 } });
    try {
      const r1 = await post(s.app, { stream: true });
      const reader = r1.body!.getReader();
      await reader.read();
      // A patient client keeps reading (pings, then the error event).
      const drain = (async () => { while (!(await reader.read()).done) { /* */ } })();
      await Bun.sleep(2000);
      const r2 = await post(s.app, {});
      expect(r2.status).toBe(200);
      await drain;
    } finally { s.stop(); }
  }, 10000);

  it("idle timeout after output started counts as neither breaker success nor failure", async () => {
    const s = setup(() => new Response(stallingBody(chunk("hel")).body, { headers: { "content-type": "text/event-stream" } }),
      { server: { sseHeartbeatSeconds: 0, streamIdleTimeoutSeconds: 0.3 } } as never,
      { circuitBreaker: { failureThreshold: 1, successThreshold: 1, maxHalfThreshold: 1, timeoutMs: 30000 } });
    try {
      const r = await post(s.app, { stream: true });
      const { text, ended } = await readFor(r, 3000);
      expect(ended).toBe(true);
      expect(text).toContain("stream_idle_timeout");
      await Bun.sleep(50);
      // failureThreshold=1: a recorded failure would open the breaker.
      const b = s.gw.getCircuitBreakerRegistry().get("up")!;
      expect(b).toBeDefined();
      expect(b.getState()).toBe("CLOSED");
      expect((b as unknown as { consecutiveSuccesses: number }).consecutiveSuccesses).toBe(0);
    } finally { s.stop(); }
  }, 10000);
});

describe("stream max duration (optional)", () => {
  it("ends a still-flowing stream after streamMaxDurationSeconds", async () => {
    const enc = new TextEncoder();
    const s = setup(() => new Response(new ReadableStream<Uint8Array>({
      async pull(c) { await Bun.sleep(50); c.enqueue(enc.encode(chunk("t"))); },
    }), { headers: { "content-type": "text/event-stream" } }), { server: { sseHeartbeatSeconds: 0, streamMaxDurationSeconds: 0.5 } } as never);
    try {
      const r = await post(s.app, { stream: true });
      const { text, ended } = await readFor(r, 3000);
      expect(ended).toBe(true);
      expect(text).toContain("stream_max_duration");
      expect(text).not.toContain("[DONE]");
    } finally { s.stop(); }
  }, 10000);
});
