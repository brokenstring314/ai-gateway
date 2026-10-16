import { describe, it, expect } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { parseSSEStream } from "@/providers/sse-parser";
import type { GatewayConfig } from "@/config/types";

describe("abort semantics", () => {
  // S5: since a7ecf3a the upstream-timeout path is AbortError -> handleGatewayError -> 500
  // "Internal server error" (was 502 provider_error). A timeout should be 504.
  it("S5: request timeout against hung upstream returns 504 (not 500 internal_error)", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(3000); return new Response("{}"); } });
    try {
      const cfg = { requestTimeout: "1s", strategy: { mode: "single", targets: ["a"] }, targets: [{ name: "a", provider: "openai", apiKey: "k", baseURL: `http://127.0.0.1:${server.port}/v1`, models: ["m"] }] } as any as GatewayConfig;
      const app = createApp(new Gateway(cfg), cfg);
      const r = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
      expect(r.status).toBe(504);
    } finally { server.stop(true); }
  }, 10000);

  // S6: abort observed between reads makes parseSSEStream return normally (truncated
  // stream looks like a clean finish -> breaker success, fallback "done", no error).
  it("S6: abort between reads must throw, not end the stream cleanly", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(enc.encode(`data: {"id":"1","choices":[{"index":0,"delta":{"content":"t"}}]}\n\n`)); },
    });
    const ac = new AbortController();
    const it = parseSSEStream(body, ac.signal);
    await it.next();
    ac.abort();
    const res = await it.next().then((r) => ({ done: r.done }), (e) => ({ err: e.name }));
    expect(res).toEqual({ err: "AbortError" });
  });
});
