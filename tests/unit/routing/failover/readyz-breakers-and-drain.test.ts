// R3-H5 (B3-1 / C3-4): /readyz went 503 whenever ANY breaker was OPEN, even
// while fallback served 100% of traffic -> every replica pulled at once.
// Readiness is now independent of upstream breaker state (reported in the
// body instead). C3-7 / B3-9: during SIGTERM drain /readyz must answer 503
// immediately and new requests must be refused.
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { mk, req, tgt, code } from "./_h";
import { registerReadinessHandler } from "@/handlers/health";
import { createApp } from "@/app";
import { ShutdownManager } from "@/server/shutdown";

const cb = { failureThreshold: 1, timeoutMs: 60_000 };

describe("/readyz vs open breakers", () => {
  it("fallback serving fine with primary breaker OPEN -> readyz 200, state in body", async () => {
    const { g } = mk(
      {
        strategy: { mode: "fallback", targets: ["primary", "backup"] },
        targets: [tgt("primary", { circuitBreaker: cb }), tgt("backup")],
      },
      ["primary", "backup"],
      { primary: "fail", backup: "ok" },
    );
    const results: string[] = [];
    for (let i = 0; i < 5; i++) results.push(await code(g.route({} as any, req)));
    const app = new Hono();
    registerReadinessHandler(app as any, g);
    const r = await app.request("/readyz");
    const body = (await r.json()) as any;
    expect(results.every((x) => x === "ok:backup")).toBe(true);
    expect(r.status).toBe(200);
    expect(body.circuitBreakers).toEqual({ primary: "OPEN" });
    expect(body.upstreamAvailable).toBe(true);
  });

  it("every target OPEN -> still ready (pulling pods cannot fix an upstream), upstreamAvailable=false", async () => {
    const { g } = mk(
      {
        strategy: { mode: "fallback", targets: ["a", "b"] },
        targets: [tgt("a", { circuitBreaker: cb }), tgt("b", { circuitBreaker: cb })],
      },
      ["a", "b"],
      { a: "fail", b: "fail" },
    );
    await code(g.route({} as any, req));
    const app = new Hono();
    registerReadinessHandler(app as any, g);
    const r = await app.request("/readyz");
    const body = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(body.upstreamAvailable).toBe(false);
  });
});

describe("graceful shutdown drain", () => {
  it("readyz 503 and new requests refused as soon as shutdown starts", async () => {
    const cfg: any = { strategy: { mode: "single", targets: ["a"] }, targets: [tgt("a")] };
    const { g } = mk(cfg, ["a"], { a: "ok" });
    const shutdown = new ShutdownManager({ shutdownGraceMs: 200 });
    const app = createApp(g, cfg, undefined, undefined, { inFlightTracker: shutdown.inFlight });
    expect((await app.request("/readyz")).status).toBe(200);

    shutdown.inFlight.increment(); // a long request still in flight keeps the drain open
    const done = shutdown.shutdown("test");
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(((await ready.json()) as any).draining).toBe(true);
    const chat = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(503);
    expect((await app.request("/livez")).status).toBe(200);
    shutdown.inFlight.decrement();
    await done;
  });
});
