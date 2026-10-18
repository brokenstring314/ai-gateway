// B3-12 regression: the per-IP limiter must key on the real peer address
// ((c.env as Server).requestIP), be off unless configured, be config-driven
// (server.perIpRateLimit, env overrides), and send Retry-After on 429.
import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createApp } from "@/app";
import { Gateway } from "@/gateway";
import { perIpRateLimitMiddleware, requestRemoteAddress } from "@/middleware/per-ip-rate-limit";
import type { GatewayConfig } from "@/config/types";

function cfg(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["mock"] },
    targets: [{ name: "mock", provider: "openai", apiKey: "sk-x", baseURL: "http://127.0.0.1:1/v1", models: ["gpt-4o"] }],
    auth: { enabled: false },
    ...extra,
  };
}

const serverEnv = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 1 }) });

const savedEnv = { rps: process.env["RATE_LIMIT_RPS"], burst: process.env["RATE_LIMIT_BURST"] };
afterEach(() => {
  if (savedEnv.rps === undefined) delete process.env["RATE_LIMIT_RPS"];
  else process.env["RATE_LIMIT_RPS"] = savedEnv.rps;
  if (savedEnv.burst === undefined) delete process.env["RATE_LIMIT_BURST"];
  else process.env["RATE_LIMIT_BURST"] = savedEnv.burst;
});

describe("B3-12 per-IP limiter", () => {
  it("requestRemoteAddress reads Bun's Server passed as env", async () => {
    const app = new Hono();
    app.get("/", (c) => c.text(requestRemoteAddress(c)));
    expect(await (await app.fetch(new Request("http://x/"), serverEnv("10.1.2.3"))).text()).toBe("10.1.2.3");
    expect(await (await app.request("/")).text()).toBe("unknown");
  });

  it("real Bun.serve: clients are keyed by their address, not one global 'unknown' bucket", async () => {
    delete process.env["RATE_LIMIT_RPS"];
    delete process.env["RATE_LIMIT_BURST"];
    const app = createApp(new Gateway(cfg()), cfg({ server: { perIpRateLimit: { rps: 1, burst: 1 } } }));
    let seen = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => {
        seen = srv.requestIP(req)?.address ?? "";
        return app.fetch(req, srv);
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/v1/models`;
      expect((await fetch(url)).status).toBe(200);
      const limited = await fetch(url);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(seen).toBe("127.0.0.1");
      // A different peer address has its own bucket.
      const other = await app.fetch(new Request("http://x/v1/models"), serverEnv("10.9.9.9"));
      expect(other.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  it("off by default: no 429 without configuration", async () => {
    delete process.env["RATE_LIMIT_RPS"];
    delete process.env["RATE_LIMIT_BURST"];
    const app = createApp(new Gateway(cfg()), cfg());
    for (let i = 0; i < 100; i++) {
      expect((await app.fetch(new Request("http://x/v1/models"), serverEnv("10.0.0.1"))).status).toBe(200);
    }
  });

  it("env RATE_LIMIT_RPS / RATE_LIMIT_BURST override the config", async () => {
    process.env["RATE_LIMIT_RPS"] = "1";
    process.env["RATE_LIMIT_BURST"] = "2";
    const app = createApp(new Gateway(cfg()), cfg({ server: { perIpRateLimit: { rps: 1000, burst: 1000 } } }));
    const hit = () => app.fetch(new Request("http://x/v1/models"), serverEnv("10.0.0.2"));
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });

  it("burst defaults to 2 × rps; Retry-After reflects the refill time", async () => {
    let now = 0;
    const app = new Hono();
    app.use("*", perIpRateLimitMiddleware({ rps: 0.5, resolveClientIp: () => "a", nowMs: () => now }));
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("/")).status).toBe(200);
    const r = await app.request("/");
    expect(r.status).toBe(429); // burst = max(1, ceil(2 * 0.5)) = 1
    expect(r.headers.get("Retry-After")).toBe("2");
    now += 2000;
    expect((await app.request("/")).status).toBe(200);
  });

  it("idle buckets are swept", async () => {
    let now = 0;
    const limit = perIpRateLimitMiddleware({ rps: 10, burst: 10, resolveClientIp: (c) => c.req.header("x-ip") ?? "", nowMs: () => now });
    const app = new Hono();
    app.use("*", limit);
    app.get("/", (c) => c.text("ok"));
    now = 60_000;
    for (let i = 0; i < 50; i++) await app.request("/", { headers: { "x-ip": `ip-${i}` } });
    expect(limit.size()).toBe(50);
    now += 120_000;
    await app.request("/", { headers: { "x-ip": "fresh" } });
    expect(limit.size()).toBe(1);
  });

  it("schema accepts server.perIpRateLimit", async () => {
    const { safeParseConfig } = await import("@/config/schema");
    expect(safeParseConfig({ ...cfg(), server: { perIpRateLimit: { rps: 50, burst: 100 } } }).success).toBe(true);
    expect(safeParseConfig({ ...cfg(), server: { perIpRateLimit: { rps: -1 } } }).success).toBe(false);
  });
});
