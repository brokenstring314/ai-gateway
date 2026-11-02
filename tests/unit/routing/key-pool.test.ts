/** Upstream key pools (0.3.0 P4): selection modes, 429 cooldown, 401 auto-disable, 402 soft cooldown (C7). */
import { describe, expect, it } from "bun:test";
import {
  type KeyEvent,
  KeyPool,
  KeyStateRegistry,
  keyErrorText,
  NoUsableKeyError,
  parseRetryAfter,
  type PoolKey,
} from "../../../src/routing/key-pool.js";

const keys = (...weights: number[]): PoolKey[] =>
  weights.map((w, i) => ({ id: `k${i}`, key: `sk-key-${i}`, weight: w, revision: "r" }));

function pool(strategy: "round_robin" | "weighted" | "fill_first", list: PoolKey[], now = () => 1_000_000) {
  const registry = new KeyStateRegistry();
  const events: KeyEvent[] = [];
  registry.onEvent((e) => events.push(e));
  return { p: new KeyPool("ch", list, strategy, 30, registry, now), registry, events };
}

describe("KeyPool selection", () => {
  it("round_robin rotates through the keys", () => {
    const { p } = pool("round_robin", keys(1, 1, 1));
    expect([1, 2, 3, 4, 5, 6].map(() => p.acquire().id)).toEqual(["k0", "k1", "k2", "k0", "k1", "k2"]);
  });

  it("fill_first sticks to the first usable key", () => {
    const { p } = pool("fill_first", keys(1, 1));
    expect([1, 2, 3].map(() => p.acquire().id)).toEqual(["k0", "k0", "k0"]);
    p.report("k0", 429, "5", "429: slow down");
    expect(p.acquire().id).toBe("k1");
  });

  it("weighted follows the weights; weight 0 drains a key in every mode", () => {
    const { p } = pool("weighted", keys(3, 1, 0));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const id = p.acquire().id;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    expect(counts["k2"]).toBeUndefined();
    expect(counts["k0"]! / counts["k1"]!).toBeGreaterThan(2.3);
    expect(counts["k0"]! / counts["k1"]!).toBeLessThan(3.9);
    const rr = pool("round_robin", keys(1, 0)).p;
    expect([1, 2, 3].map(() => rr.acquire().id)).toEqual(["k0", "k0", "k0"]);
  });

  it("acquire skips excluded keys and throws when none is left", () => {
    const { p } = pool("round_robin", keys(1, 1));
    expect(p.acquire(new Set(["k0"])).id).toBe("k1");
    expect(() => p.acquire(new Set(["k0", "k1"]))).toThrow(NoUsableKeyError);
  });

  it("a pool without keys is unavailable", () => {
    const { p } = pool("round_robin", []);
    expect(p.available()).toBe(false);
    expect(() => p.acquire()).toThrow(/no usable upstream key/);
  });
});

describe("KeyPool health", () => {
  it("429 cools the key down for Retry-After seconds (capped at 1h), else the channel default", () => {
    let t = 1_000_000;
    const { p, events } = pool("round_robin", keys(1, 1), () => t);
    expect(p.report("k0", 429, "7", "429: rate limited")).toBe(true);
    expect(events[0]).toMatchObject({ kind: "cooldown", keyId: "k0", seconds: 7 });
    expect([1, 2, 3].map(() => p.acquire().id)).toEqual(["k1", "k1", "k1"]);
    t += 7001;
    expect(new Set([1, 2, 3, 4].map(() => p.acquire().id))).toEqual(new Set(["k0", "k1"]));
    p.report("k1", 429, null, "429");
    expect(events.at(-1)).toMatchObject({ kind: "cooldown", keyId: "k1", seconds: 30 });
    p.report("k0", 429, "999999", "429");
    expect(events.at(-1)).toMatchObject({ kind: "cooldown", keyId: "k0", seconds: 3600 });
  });

  it("every key cooling: NoUsableKeyError carries the shortest wait", () => {
    const t = 1_000_000;
    const { p } = pool("round_robin", keys(1, 1), () => t);
    p.report("k0", 429, "20", "429");
    p.report("k1", 429, "5", "429");
    expect(p.available()).toBe(false);
    try {
      p.acquire();
      throw new Error("expected NoUsableKeyError");
    } catch (err) {
      expect(err).toBeInstanceOf(NoUsableKeyError);
      expect((err as NoUsableKeyError).retryAfterSeconds).toBe(5);
    }
  });

  it("401 disables (invalid) once; 402 only cools down; other statuses do nothing", () => {
    const { p, events } = pool("round_robin", keys(1, 1, 1));
    expect(p.report("k0", 401, null, "401: bad key")).toBe(true);
    expect(p.report("k0", 401, null, "401: bad key")).toBe(true);
    expect(p.report("k1", 402, null, "402: no balance")).toBe(true);
    expect(p.report("k2", 500, null, "500")).toBe(false);
    expect(p.report("k2", 403, null, "403")).toBe(false);
    expect(events.filter((e) => e.kind === "disabled")).toEqual([
      expect.objectContaining({ keyId: "k0", status: "invalid", httpStatus: 401 }),
    ]);
    expect(events.filter((e) => e.kind === "cooldown")).toEqual([
      expect.objectContaining({ keyId: "k1", seconds: 30, httpStatus: 402 }),
    ]);
    expect([1, 2].map(() => p.acquire().id)).toEqual(["k2", "k2"]);
    const snap = p.snapshot();
    expect(snap[0]?.disabled?.status).toBe("invalid");
    expect(snap[1]?.disabled).toBeUndefined();
    expect(snap[1]?.cooldownUntil).toBeDefined();
    expect(snap[2]?.disabled).toBeUndefined();
  });

  it("state survives a rebuilt pool (reload) and resets when an operator re-enables the key", () => {
    const registry = new KeyStateRegistry();
    const a = new KeyPool("ch", keys(1, 1), "round_robin", 30, registry);
    a.report("k0", 401, null, "401");
    const b = new KeyPool("ch", keys(1, 1), "round_robin", 30, registry);
    expect([1, 2].map(() => b.acquire().id)).toEqual(["k1", "k1"]);
    registry.reset("ch", "k0");
    expect(new Set([1, 2].map(() => b.acquire().id))).toEqual(new Set(["k0", "k1"]));
  });

  it("retain drops the state of keys that are gone", () => {
    const registry = new KeyStateRegistry();
    const list = keys(1);
    new KeyPool("ch", list, "round_robin", 30, registry).report("k0", 401, null, "401");
    registry.retain(new Set());
    expect(new KeyPool("ch", list, "round_robin", 30, registry).available()).toBe(true);
  });
});

describe("helpers", () => {
  it("parseRetryAfter: seconds or HTTP date", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter("1.2")).toBe(2);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-11-02T00:00:00Z");
    expect(parseRetryAfter("Mon, 02 Nov 2026 00:01:00 GMT", now)).toBe(60);
  });

  it("keyErrorText never contains the key", () => {
    const key = "sk-live-0123456789abcdef";
    const text = keyErrorText(401, `Incorrect API key provided: ${key}. Also sk-abc***wxyz is not valid`, key);
    expect(text).not.toContain(key);
    expect(text).not.toContain("sk-abc***wxyz");
    expect(text.startsWith("401: ")).toBe(true);
    expect(keyErrorText(500, "x".repeat(1000), key).length).toBeLessThanOrEqual(300);
  });
});
