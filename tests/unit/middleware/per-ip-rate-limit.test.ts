import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import { perIpRateLimitMiddleware } from "@/middleware/per-ip-rate-limit";
import type { RateLimitMiddleware } from "@/middleware/per-ip-rate-limit";

const ERROR_BODY = {
  error: {
    message: "Rate limit exceeded",
    type: "rate_limit_error",
    code: "rate_limited",
  },
};

function ipResolver(ip: string): (c: Context) => string {
  return () => ip;
}

function makeClock() {
  let now = 0;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function createApp(limit: RateLimitMiddleware) {
  const app = new Hono();
  app.use("*", limit);
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

describe("perIpRateLimitMiddleware", () => {
  it("allows requests below the limit", async () => {
    const clock = makeClock();
    const app = createApp(
      perIpRateLimitMiddleware({
        rps: 10,
        burst: 10,
        resolveClientIp: ipResolver("1.2.3.4"),
        nowMs: clock.nowMs,
      }),
    );
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/");
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 with the exact error JSON once the burst is exhausted", async () => {
    const clock = makeClock();
    const app = createApp(
      perIpRateLimitMiddleware({
        rps: 5,
        burst: 3,
        resolveClientIp: ipResolver("1.2.3.4"),
        nowMs: clock.nowMs,
      }),
    );
    for (let i = 0; i < 3; i++) {
      expect((await app.request("/")).status).toBe(200);
    }
    const res = await app.request("/");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(ERROR_BODY);
  });

  it("keeps buckets independent per IP", async () => {
    const clock = makeClock();
    const app = createApp(
      perIpRateLimitMiddleware({
        rps: 5,
        burst: 2,
        resolveClientIp: (c) => c.req.header("x-client-ip") ?? "unknown",
        nowMs: clock.nowMs,
      }),
    );
    for (let i = 0; i < 2; i++) {
      expect((await app.request("/", { headers: { "x-client-ip": "10.0.0.1" } })).status).toBe(200);
      expect((await app.request("/", { headers: { "x-client-ip": "10.0.0.2" } })).status).toBe(200);
    }
    expect((await app.request("/", { headers: { "x-client-ip": "10.0.0.1" } })).status).toBe(429);
    expect((await app.request("/", { headers: { "x-client-ip": "10.0.0.2" } })).status).toBe(429);
    expect((await app.request("/", { headers: { "x-client-ip": "10.0.0.3" } })).status).toBe(200);
  });

  it("is disabled when rps is 0", async () => {
    const clock = makeClock();
    const app = createApp(
      perIpRateLimitMiddleware({
        rps: 0,
        burst: 2,
        resolveClientIp: ipResolver("1.2.3.4"),
        nowMs: clock.nowMs,
      }),
    );
    for (let i = 0; i < 50; i++) {
      expect((await app.request("/")).status).toBe(200);
    }
  });

  it("is disabled when burst is 0", async () => {
    const clock = makeClock();
    const app = createApp(
      perIpRateLimitMiddleware({
        rps: 5,
        burst: 0,
        resolveClientIp: ipResolver("1.2.3.4"),
        nowMs: clock.nowMs,
      }),
    );
    for (let i = 0; i < 50; i++) {
      expect((await app.request("/")).status).toBe(200);
    }
  });

  it("allows a burst larger than the sustained rate, then throttles", async () => {
    const clock = makeClock();
    const app = createApp(
      perIpRateLimitMiddleware({
        rps: 1,
        burst: 5,
        resolveClientIp: ipResolver("1.2.3.4"),
        nowMs: clock.nowMs,
      }),
    );
    for (let i = 0; i < 5; i++) {
      expect((await app.request("/")).status).toBe(200);
    }
    expect((await app.request("/")).status).toBe(429);
  });

  it("refills tokens over time", async () => {
    const clock = makeClock();
    const app = createApp(
      perIpRateLimitMiddleware({
        rps: 10,
        burst: 2,
        resolveClientIp: ipResolver("1.2.3.4"),
        nowMs: clock.nowMs,
      }),
    );
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(429);

    clock.advance(600); // 6 tokens refilled, capped at burst (2)
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(429);
  });

  it("exposes clear() and size() for inspection and cleanup", async () => {
    const clock = makeClock();
    const limit = perIpRateLimitMiddleware({
      rps: 5,
      burst: 2,
      resolveClientIp: (c) => c.req.header("x-client-ip") ?? "unknown",
      nowMs: clock.nowMs,
    });
    const app = createApp(limit);

    await app.request("/", { headers: { "x-client-ip": "10.0.0.1" } });
    await app.request("/", { headers: { "x-client-ip": "10.0.0.2" } });
    expect(limit.size()).toBe(2);

    // Exhaust one bucket, then clear() must reset everything.
    await app.request("/", { headers: { "x-client-ip": "10.0.0.1" } });
    await app.request("/", { headers: { "x-client-ip": "10.0.0.1" } });
    expect((await app.request("/", { headers: { "x-client-ip": "10.0.0.1" } })).status).toBe(429);

    limit.clear();
    expect(limit.size()).toBe(0);
    expect((await app.request("/", { headers: { "x-client-ip": "10.0.0.1" } })).status).toBe(200);
  });

  it("uses default rps 20 / burst 40 when no options are given", async () => {
    const clock = makeClock();
    const limit = perIpRateLimitMiddleware({ nowMs: clock.nowMs });
    const app = createApp(limit);

    for (let i = 0; i < 40; i++) {
      expect((await app.request("/")).status).toBe(200);
    }
    expect((await app.request("/")).status).toBe(429);
    expect(limit.size()).toBe(1);
  });
});
