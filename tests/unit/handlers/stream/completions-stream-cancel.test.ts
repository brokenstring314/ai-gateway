// Regression (R3-H9 / T3-6): /v1/completions stream cancel must abort upstream.
import { describe, it, expect } from "bun:test";
import { setup, chunk, post } from "./_h";

describe("/v1/completions stream: client disconnect aborts upstream", () => {
  it("cancelling the response body cancels the upstream request", async () => {
    let cancelled = false; let reqAborted = false;
    const s = setup((req) => {
      req.signal.addEventListener("abort", () => { reqAborted = true; });
      const enc = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(chunk("a"))); }, // then silent
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    }, { server: { sseHeartbeatSeconds: 0 } } as never);
    try {
      const r = await post(s.app, { stream: true, prompt: "hi", messages: undefined }, "/v1/completions");
      expect(r.status).toBe(200);
      const reader = r.body!.getReader();
      await reader.read();
      await reader.cancel();
      await Bun.sleep(500);
      expect(cancelled || reqAborted).toBe(true);
    } finally { s.stop(); }
  });
});
