/**
 * Several upstream keys per channel and channel-level balancing, from the
 * config file (0.3.0 P4): apiKeys / keyStrategy / keyCooldownSeconds,
 * models[].balance and priority groups, legacy fallback/loadbalance.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { loadConfigFromObject } from "../../src/config/loader.js";
import { toGatewayError } from "../../src/core/errors.js";
import { Gateway } from "../../src/gateway.js";
import type { KeyEvent } from "../../src/routing/key-pool.js";
import { FakeUpstreams } from "./_admin-harness.js";

const up = new FakeUpstreams();
beforeAll(() => up.install());
afterAll(() => up.uninstall());
afterEach(() => up.reset());

const ctx = () => ({ traceId: "t", metadata: {} });
const chat = (model: string) => ({ model, messages: [{ role: "user" as const, content: "hi" }] });

function target(name: string, extra: Record<string, unknown> = {}) {
  return { name, provider: "openai", baseURL: `https://${name}.upstream.test/v1`, models: ["m"], ...extra };
}

function gateway(file: Record<string, unknown>) {
  const g = new Gateway(loadConfigFromObject(file));
  const events: KeyEvent[] = [];
  g.onKeyEvent((e) => events.push(e));
  return { g, events };
}

describe("config file: apiKeys", () => {
  it("validates: apiKey or apiKeys is required; strategies and weights are checked", () => {
    expect(() => loadConfigFromObject({ strategy: { mode: "single" }, targets: [target("a")] })).toThrow(/apiKey/);
    expect(() =>
      loadConfigFromObject({
        strategy: { mode: "single" },
        targets: [target("a", { apiKeys: ["k"], keyStrategy: "random" })],
      }),
    ).toThrow(/keyStrategy/);
    expect(() =>
      loadConfigFromObject({
        strategy: { mode: "single" },
        targets: [target("a", { apiKeys: [{ key: "k", weight: -1 }] })],
      }),
    ).toThrow();
    expect(() =>
      loadConfigFromObject({
        strategy: { mode: "single" },
        targets: [target("a", { apiKeys: [{ key: "k", extra: 1 }] })],
      }),
    ).toThrow(/extra/);
  });

  it("round_robin over apiKey + apiKeys; disabled and weight-0 keys are never used", async () => {
    process.env["P4_TEST_KEY"] = "sk-from-env-0001";
    const { g } = gateway({
      strategy: { mode: "single" },
      targets: [
        target("a", {
          apiKey: "sk-first-0000",
          apiKeys: ["${P4_TEST_KEY}", { key: "sk-off-0002", enabled: false }, { key: "sk-drained-0003", weight: 0 }],
        }),
      ],
    });
    for (let i = 0; i < 4; i++) await g.route(ctx(), chat("m"));
    expect(up.calls.map((c) => c.auth)).toEqual([
      "Bearer sk-first-0000",
      "Bearer sk-from-env-0001",
      "Bearer sk-first-0000",
      "Bearer sk-from-env-0001",
    ]);
  });

  it("fill_first: one key until it is rate limited (429 → cooldown, same request retried on the next key)", async () => {
    const { g, events } = gateway({
      strategy: { mode: "single" },
      targets: [target("a", { apiKeys: ["sk-k1-aaaa", "sk-k2-bbbb"], keyStrategy: "fill_first" })],
    });
    await g.route(ctx(), chat("m"));
    await g.route(ctx(), chat("m"));
    up.enqueue("a.upstream.test", { status: 429, headers: { "Retry-After": "60" } });
    const r = await g.route(ctx(), chat("m"));
    expect(r.choices[0]?.message?.content).toBe("a:m");
    await g.route(ctx(), chat("m"));
    expect(up.calls.map((c) => c.auth)).toEqual([
      "Bearer sk-k1-aaaa",
      "Bearer sk-k1-aaaa",
      "Bearer sk-k1-aaaa", // 429
      "Bearer sk-k2-bbbb", // same request, next key
      "Bearer sk-k2-bbbb", // k1 still cooling down
    ]);
    // Retry-After 60 is capped at keyCooldownSeconds (default 30, RB5).
    expect(events).toEqual([expect.objectContaining({ kind: "cooldown", channel: "a", seconds: 30 })]);
  });

  it("402 cools a key, 401 disables one; the channel fails only when every key is out, then the next channel serves", async () => {
    const { g, events } = gateway({
      strategy: { mode: "fallback", targets: ["a", "b"] },
      targets: [target("a", { apiKeys: ["sk-a1-1111", "sk-a2-2222"] }), target("b", { apiKey: "sk-b-3333" })],
    });
    up.enqueue("a.upstream.test", 402, 401);
    const r = await g.route(ctx(), chat("m"));
    expect(r.choices[0]?.message?.content).toBe("b:m");
    expect(up.calls.map((c) => `${c.host}|${c.auth}`)).toEqual([
      "a.upstream.test|Bearer sk-a1-1111",
      "a.upstream.test|Bearer sk-a2-2222",
      "b.upstream.test|Bearer sk-b-3333",
    ]);
    expect(events.map((e) => (e.kind === "disabled" ? [e.keyId, e.status] : [e.keyId, e.kind]))).toEqual([
      ["cfg-0", "cooldown"],
      ["cfg-1", "invalid"],
    ]);
    // A 402 never takes a channel down on its own (C7): the 402-cooling key is
    // still used when it is the channel's only usable one.
    up.reset();
    expect((await g.route(ctx(), chat("m"))).choices[0]?.message?.content).toBe("a:m");
    expect(up.calls.map((c) => c.auth)).toEqual(["Bearer sk-a1-1111"]);
  });

  it("a 402 on every channel reaches the client as 402 and opens no breaker", async () => {
    const { g } = gateway({
      strategy: { mode: "fallback", targets: ["a", "b"] },
      targets: [target("a", { apiKey: "sk-a-1111" }), target("b", { apiKey: "sk-b-2222" })],
    });
    for (let i = 0; i < 2; i++) {
      up.enqueue("a.upstream.test", 402);
      up.enqueue("b.upstream.test", 402);
      const err = toGatewayError(await g.route(ctx(), chat("m")).catch((e: unknown) => e));
      expect(err.status).toBe(402);
      up.reset();
    }
    expect((await g.route(ctx(), chat("m"))).choices[0]?.message?.content).toBe("a:m");
  });

  it("429 on the only key of the only channel: the next request still reaches the upstream (soft cooldown, RB5)", async () => {
    const { g } = gateway({
      strategy: { mode: "single" },
      targets: [target("a", { apiKey: "sk-only-0000", keyCooldownSeconds: 45 })],
    });
    up.enqueue("a.upstream.test", { status: 429, headers: { "Retry-After": "120" } });
    const first = toGatewayError(await g.route(ctx(), chat("m")).catch((e: unknown) => e));
    expect(first).toMatchObject({ status: 429 });
    up.reset();
    // Never 503 no_upstream_key, and no gateway-made 429 for everyone else.
    const r = await g.route(ctx(), chat("m"));
    expect(r.choices[0]?.message?.content).toBe("a:m");
    expect(up.calls).toHaveLength(1);
  });

  it("a channel whose keys are all disabled answers 503 no_upstream_key", async () => {
    const { g } = gateway({ strategy: { mode: "single" }, targets: [target("a", { apiKey: "sk-only-0000" })] });
    up.enqueue("a.upstream.test", 401);
    await expect(g.route(ctx(), chat("m"))).rejects.toBeDefined();
    const err = toGatewayError(await g.route(ctx(), chat("m")).catch((e: unknown) => e));
    expect(err).toMatchObject({ status: 503, code: "no_upstream_key" });
  });

  it("streams fail over between keys before the first chunk", async () => {
    const { g } = gateway({
      strategy: { mode: "single" },
      targets: [target("a", { apiKeys: ["sk-s1-1111", "sk-s2-2222"] })],
    });
    up.enqueue("a.upstream.test", 429);
    let text = "";
    for await (const c of g.routeStream(ctx(), { ...chat("m"), stream: true }))
      text += c.choices[0]?.delta?.content ?? "";
    expect(text).toBe("a:m");
    expect(up.calls.map((c) => c.auth)).toEqual(["Bearer sk-s1-1111", "Bearer sk-s2-2222"]);
  });

  it("key state survives a reload of an unchanged key, and resets when the key text changes", async () => {
    const file = { strategy: { mode: "single" }, targets: [target("a", { apiKeys: ["sk-r1-1111", "sk-r2-2222"] })] };
    const { g } = gateway(file);
    up.enqueue("a.upstream.test", 401);
    await g.route(ctx(), chat("m"));
    g.reload(loadConfigFromObject(file));
    up.reset();
    for (let i = 0; i < 3; i++) await g.route(ctx(), chat("m"));
    expect(new Set(up.calls.map((c) => c.auth))).toEqual(new Set(["Bearer sk-r2-2222"]));
    g.reload(loadConfigFromObject({ ...file, targets: [target("a", { apiKeys: ["sk-r1-NEW1", "sk-r2-2222"] })] }));
    up.reset();
    for (let i = 0; i < 2; i++) await g.route(ctx(), chat("m"));
    expect(new Set(up.calls.map((c) => c.auth))).toEqual(new Set(["Bearer sk-r1-NEW1", "Bearer sk-r2-2222"]));
  });
});

describe("config file: model balancing", () => {
  const targets = [target("a", { apiKey: "k" }), target("b", { apiKey: "k" }), target("c", { apiKey: "k" })];

  it("legacy fallback (no priorities): strict order, one channel per group", async () => {
    const { g } = gateway({
      strategy: { mode: "single" },
      targets,
      models: [{ name: "m", bindings: [{ target: "b" }, { target: "a" }, { target: "c" }] }],
    });
    for (let i = 0; i < 3; i++) await g.route(ctx(), chat("m"));
    expect(new Set(up.calls.map((c) => c.host))).toEqual(new Set(["b.upstream.test"]));
    up.enqueue("b.upstream.test", 500);
    up.enqueue("a.upstream.test", 500);
    expect((await g.route(ctx(), chat("m"))).choices[0]?.message?.content).toBe("c:m");
  });

  it("legacy loadbalance: one group by weight", async () => {
    const { g } = gateway({
      strategy: { mode: "single" },
      targets,
      models: [
        {
          name: "m",
          strategy: "loadbalance",
          bindings: [
            { target: "a", weight: 1 },
            { target: "b", weight: 0 },
            { target: "c", weight: 1 },
          ],
        },
      ],
    });
    for (let i = 0; i < 40; i++) await g.route(ctx(), chat("m"));
    const hosts = new Set(up.calls.map((c) => c.host));
    expect(hosts).toEqual(new Set(["a.upstream.test", "c.upstream.test"]));
  });

  it("priority groups + round_robin: the backup group only when the whole first group fails", async () => {
    const { g } = gateway({
      strategy: { mode: "single" },
      targets,
      models: [
        {
          name: "m",
          balance: "round_robin",
          bindings: [
            { target: "a", priority: 0 },
            { target: "b", priority: 0 },
            { target: "c", priority: 1 },
          ],
        },
      ],
    });
    for (let i = 0; i < 4; i++) await g.route(ctx(), chat("m"));
    expect(up.calls.map((c) => c.host[0])).toEqual(["a", "b", "a", "b"]);
    up.reset();
    up.enqueue("b.upstream.test", 500);
    expect((await g.route(ctx(), chat("m"))).choices[0]?.message?.content).toBe("a:m"); // b failed → a, same group
    up.enqueue("a.upstream.test", 500);
    up.enqueue("b.upstream.test", 500);
    expect((await g.route(ctx(), chat("m"))).choices[0]?.message?.content).toBe("c:m");
  });

  it("least_inflight spreads concurrent requests", async () => {
    const { g } = gateway({
      strategy: { mode: "single" },
      targets,
      models: [
        { name: "m", strategy: "loadbalance", balance: "least_inflight", bindings: [{ target: "a" }, { target: "b" }] },
      ],
    });
    // Requests must really overlap in flight, and each must be routed after the previous one
    // is counted: a burst started in one tick picks its order before any attempt is counted
    // (all ties, i.e. random), and an instant fake upstream let a slow CI runner finish them
    // one by one (CI flake). Hold every answer 200 ms and start them 5 ms apart.
    up.delayMs = 200;
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      runs.push(g.route(ctx(), chat("m")));
      await Bun.sleep(5);
    }
    await Promise.all(runs);
    const a = up.hits("a.upstream.test").length;
    expect(a).toBeGreaterThanOrEqual(3);
    expect(a).toBeLessThanOrEqual(7);
  });

  it("a disabled target is skipped; a model left without usable bindings is 503, its alias too", async () => {
    const { g } = gateway({
      strategy: { mode: "single", targets: ["c"] },
      targets: [
        target("a", { apiKey: "k", enabled: false }),
        target("b", { apiKey: "k" }),
        target("c", { apiKey: "k" }),
      ],
      models: [
        { name: "m", bindings: [{ target: "a" }, { target: "b" }] },
        { name: "dead", bindings: [{ target: "a" }, { target: "b", enabled: false }] },
        { name: "empty", bindings: [] },
      ],
      aliases: { d: "dead" },
    });
    expect((await g.route(ctx(), chat("m"))).choices[0]?.message?.content).toBe("b:m");
    for (const name of ["dead", "d", "empty"]) {
      expect(toGatewayError(await g.route(ctx(), chat(name)).catch((e: unknown) => e))).toMatchObject({
        status: 503,
        code: "model_unavailable",
      });
    }
    await expect(g.route(ctx(), chat("nope"))).rejects.toMatchObject({ status: 404 });
  });
});
