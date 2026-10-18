import { describe, it, expect } from "bun:test";
import { setup, sse, chunk, post, readFor } from "./_h";

describe("T3-3 data: [DONE] does not end the stream; gateway waits for upstream EOF and forwards post-DONE data", () => {
  it.failing("client must get [DONE] promptly after upstream sends it even if upstream keeps the socket open", async () => {
    const s = setup(() => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(chunk("ok", "stop") + "data: [DONE]\n\n"));
          await Bun.sleep(1500);
          c.enqueue(enc.encode(chunk("GARBAGE-AFTER-DONE")));
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }, { server: { sseHeartbeatSeconds: 0 } } as never);
    try {
      const r = await post(s.app, { stream: true });
      const t0 = Date.now();
      const { text } = await readFor(r, 3000);
      const doneAt = text.indexOf("[DONE]");
      expect(doneAt).toBeGreaterThan(-1);
      expect(text).not.toContain("GARBAGE-AFTER-DONE"); // BUG: forwarded
      expect(Date.now() - t0).toBeLessThan(1000); // BUG: ~1500ms, waits for upstream EOF
    } finally { s.stop(); }
  }, 10000);
});

describe("T3-4 (known, still reproduces) truncated upstream stream is reported as a clean completion", () => {
  it.failing("EOF without [DONE] / finish_reason must not end with data: [DONE] and no error", async () => {
    const s = setup(() => sse([chunk("The answer is"), chunk(" 4")])); // connection closes mid-answer
    try {
      const r = await post(s.app, { stream: true });
      const text = await r.text();
      // BUG: client sees a normal [DONE] terminator; no error event, no finish_reason
      expect(text).toContain("error");
    } finally { s.stop(); }
  });
});

describe("T3-5 200 non-SSE upstream body on a stream request becomes an empty successful stream", () => {
  it.failing("JSON error body with 200 + application/json is silently swallowed (no error, no fallback)", async () => {
    const s = setup(() => new Response(JSON.stringify({ error: { message: "model overloaded", type: "server_error" } }), { headers: { "content-type": "application/json" } }));
    try {
      const r = await post(s.app, { stream: true });
      const text = await r.text();
      // BUG: status 200, body is exactly "data: [DONE]\n\n" — the upstream error vanished
      expect(r.status === 200 && text.trim() === "data: [DONE]").toBe(false);
    } finally { s.stop(); }
  });
  it.failing("upstream ignored stream:true and returned a normal chat.completion JSON -> content lost", async () => {
    const s = setup(() => Response.json({ id: "x", object: "chat.completion", created: 1, model: "gpt-4o", choices: [{ index: 0, message: { role: "assistant", content: "real answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    try {
      const r = await post(s.app, { stream: true });
      const text = await r.text();
      expect(text.includes("real answer") || text.includes("error")).toBe(true); // BUG: neither
    } finally { s.stop(); }
  });
  it.failing("with fallback, an empty 200 stream from target A is not failed over to target B", async () => {
    const good = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => sse([chunk("from-B", "stop"), "data: [DONE]\n\n"]) });
    const s = setup(() => new Response("", { headers: { "content-type": "text/event-stream" } }), {
      strategy: { mode: "fallback", targets: ["up", "b"] },
    } as never);
    (s.config.targets as unknown[]).push({ name: "b", provider: "openai", apiKey: "sk", baseURL: `http://127.0.0.1:${good.port}/v1`, models: ["gpt-4o"] });
    const { Gateway } = await import("@/gateway");
    const { createApp } = await import("@/app");
    const gw = new Gateway(s.config);
    const app = createApp(gw, s.config);
    try {
      const r = await post(app, { stream: true });
      const text = await r.text();
      expect(text).toContain("from-B"); // BUG: client gets just [DONE]
    } finally { s.stop(); good.stop(true); }
  });
});

