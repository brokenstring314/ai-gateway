import { describe, it, expect } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import type { GatewayConfig } from "@/config/types";

// S2: gateway request timeout against a hung upstream is an AbortError, which
//     guardProvider treats as "client abort" -> a hanging upstream NEVER opens the breaker.
// S3: client disconnect mid-stream surfaces from parseSSEStream as ReadableStreamError
//     (not AbortError) -> counted as an upstream failure; N closed tabs open the breaker
//     for everyone.
// S4: upstream 4xx caused by one caller's bad request (400) counts as a breaker failure
//     -> one tenant can open the circuit for all tenants.

const body = (stream = false) => JSON.stringify({ model: "m", stream, messages: [{ role: "user", content: "hi" }] });

function mkCfg(port: number, extra: any = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["a"] },
    targets: [{ name: "a", provider: "openai", apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, models: ["m"], circuitBreaker: { failureThreshold: 2, timeoutMs: 60000 } }],
    ...extra,
  } as any;
}

describe("breaker outcome classification", () => {
  it("S2: hung upstream hitting requestTimeout never trips the breaker", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(3000); return new Response("{}"); } });
    try {
      const cfg = mkCfg(server.port, { requestTimeout: "1s" });
      const gw = new Gateway(cfg);
      const app = createApp(gw, cfg);
      for (let i = 0; i < 3; i++) {
        await app.request("/v1/chat/completions", { method: "POST", body: body(), headers: { "content-type": "application/json" } });
      }
      expect(gw.getCircuitBreakerRegistry().get("a")!.getState()).toBe("OPEN");
    } finally { server.stop(true); }
  }, 10000);

  it("S3: client disconnects mid-stream are counted as upstream failures", async () => {
    const enc = new TextEncoder();
    const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({
      async pull(c) {
        c.enqueue(enc.encode(`data: {"id":"1","choices":[{"index":0,"delta":{"content":"t"}}]}\n\n`));
        await Bun.sleep(100);
      },
    }), { headers: { "content-type": "text/event-stream" } }) });
    try {
      const cfg = mkCfg(server.port);
      const gw = new Gateway(cfg);
      const app = createApp(gw, cfg);
      for (let i = 0; i < 2; i++) {
        const r = await app.request("/v1/chat/completions", { method: "POST", body: body(true), headers: { "content-type": "application/json" } });
        const reader = r.body!.getReader();
        await reader.read();
        await reader.cancel();            // user closes tab
        await Bun.sleep(150);
      }
      expect(gw.getCircuitBreakerRegistry().get("a")!.getState()).toBe("CLOSED");
    } finally { server.stop(true); }
  }, 10000);

  it("S4: caller-caused upstream 400s open the breaker for everyone", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ error: { message: "bad tool schema", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } }) });
    try {
      const cfg = mkCfg(server.port);
      const gw = new Gateway(cfg);
      const app = createApp(gw, cfg);
      for (let i = 0; i < 2; i++) {
        await app.request("/v1/chat/completions", { method: "POST", body: body(), headers: { "content-type": "application/json" } });
      }
      expect(gw.getCircuitBreakerRegistry().get("a")!.getState()).toBe("CLOSED");
    } finally { server.stop(true); }
  });
});
