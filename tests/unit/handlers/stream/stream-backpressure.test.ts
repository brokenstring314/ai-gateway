// Regression (R3-H8 / T3-2, B3-4): a client that stops reading must stop
// upstream reads instead of the gateway buffering the whole answer.
import { describe, it, expect } from "bun:test";
import { setup, post } from "./_h";

for (const path of ["/v1/chat/completions", "/v1/completions"]) {
  describe(`SSE backpressure (${path})`, () => {
    it("a client that reads nothing does not pull the whole upstream body; reading resumes it", async () => {
      // 1500 x 64 KiB ≈ 94 MiB. Without backpressure all of it is drained into the
      // gateway (RSS +200 MiB); with it, only transport buffers (loopback TCP +
      // fetch, ~8 MiB here, independent of TOTAL) fill before reads stop.
      const TOTAL = 1500;
      let produced = 0;
      const pad = "x".repeat(64 * 1024);
      const enc = new TextEncoder();
      const s = setup(() => new Response(new ReadableStream<Uint8Array>({
        pull(c) {
          if (produced >= TOTAL) { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); return; }
          produced++;
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: pad }, finish_reason: null }] })}\n\n`));
        },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }), { server: { sseHeartbeatSeconds: 0.05 } } as never);
      try {
        const extra = path === "/v1/completions" ? { prompt: "hi", messages: undefined } : {};
        const r = await post(s.app, { stream: true, ...extra }, path);
        const rss0 = process.memoryUsage().rss;
        await Bun.sleep(1500); // client reads nothing
        const stalledAt = produced;
        await Bun.sleep(500);
        expect(produced).toBe(stalledAt); // upstream reads stopped
        expect(produced).toBeLessThan(TOTAL / 5);
        expect(process.memoryUsage().rss - rss0).toBeLessThan(64 * 1048576);
        // Draining the body completes the stream normally.
        const text = await r.text();
        expect(produced).toBe(TOTAL);
        expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
      } finally { s.stop(); }
    }, 20000);
  });
}
