// Regression (N9): Bun.serve's default idleTimeout (10s) cut SSE streams when
// upstream went silent; the server now uses idleTimeout 255 by default and
// streams send `: ping` comments while idle.
import { afterEach, describe, expect, it } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import type { GatewayConfig } from "@/config/types";
import { resolveIdleTimeout } from "@/index";
import { heartbeatIntervalMs, SSE_PING } from "@/handlers/sse-heartbeat";
import { parseConfig } from "@/config/schema";

let cleanup: (() => void)[] = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

const chunk = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

/** Upstream that sends one chunk, goes silent for `pauseMs`, then finishes. */
function pausingUpstream(pauseMs: number) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode(chunk("a")));
          await Bun.sleep(pauseMs);
          c.enqueue(enc.encode(chunk("b", "stop")));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  cleanup.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}/v1`;
}

function gatewayServer(upstream: string, server: Record<string, unknown>) {
  const cfg = {
    auth: { enabled: false },
    strategy: { mode: "single", targets: ["up"] },
    targets: [{ name: "up", provider: "openai", apiKey: "sk", baseURL: upstream, models: ["gpt-4o"] }],
    server,
  } as unknown as GatewayConfig;
  const gw = new Gateway(cfg);
  const app = createApp(gw, cfg);
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: resolveIdleTimeout(undefined), fetch: app.fetch });
  cleanup.push(() => { s.stop(true); gw.close(); });
  return `http://127.0.0.1:${s.port}`;
}

describe("N9 SSE idle timeout / heartbeat", () => {
  it("defaults Bun idleTimeout to 255s and clamps configured values", () => {
    expect(resolveIdleTimeout(undefined)).toBe(255);
    expect(resolveIdleTimeout(0)).toBe(0);
    expect(resolveIdleTimeout(60)).toBe(60);
    expect(resolveIdleTimeout(10_000)).toBe(255);
    expect(heartbeatIntervalMs(undefined)).toBe(5000);
    expect(heartbeatIntervalMs(0)).toBe(0);
  });

  it("config schema accepts server.idleTimeoutSeconds / sseHeartbeatSeconds", () => {
    const c = parseConfig({
      strategy: { mode: "single", targets: ["a"] },
      targets: [{ name: "a", provider: "openai", apiKey: "sk" }],
      server: { idleTimeoutSeconds: 120, sseHeartbeatSeconds: 2 },
    });
    expect(c.server?.idleTimeoutSeconds).toBe(120);
    expect(c.server?.sseHeartbeatSeconds).toBe(2);
  });

  for (const path of ["/v1/chat/completions", "/v1/completions"]) {
    it(`${path}: sends ': ping' while upstream is silent and still delivers every chunk`, async () => {
      const base = gatewayServer(pausingUpstream(500), { sseHeartbeatSeconds: 0.1 });
      const body = path === "/v1/completions"
        ? { model: "gpt-4o", prompt: "x", stream: true }
        : { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "x" }] };
      const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await r.text();
      expect(r.status).toBe(200);
      expect(text).toContain(SSE_PING);
      expect(text).toContain("[DONE]");
      expect(text.indexOf(SSE_PING)).toBeGreaterThan(text.indexOf("data:"));
    }, 10000);
  }

  it("no heartbeat when disabled", async () => {
    const base = gatewayServer(pausingUpstream(300), { sseHeartbeatSeconds: 0 });
    const r = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "x" }] }) });
    const text = await r.text();
    expect(text).not.toContain(SSE_PING);
    expect(text).toContain("[DONE]");
  });
});
