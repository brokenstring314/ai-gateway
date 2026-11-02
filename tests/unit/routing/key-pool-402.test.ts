/**
 * C7 (review 2026-11-02, redteam RB4): an upstream 402 used to disable the
 * key for good, and some 402s are caused by the request (OpenRouter: "requires
 * more credits, or fewer max_tokens", in-flight reservations), so any client
 * could take the operator's key — and a single-key channel — down. Now a 402
 * is a soft cooldown; only DISABLE_AFTER_402 consecutive account-level 402s
 * (no success in between, within the window) disable the key.
 */
import { describe, expect, it } from "bun:test";
import {
  DISABLE_AFTER_402,
  isRequestLevel402,
  type KeyEvent,
  KeyPool,
  KeyStateRegistry,
  MAX_KEY_COOLDOWN_SECONDS,
  NoUsableKeyError,
  PAYMENT_FAILURE_WINDOW_MS,
  type PoolKey,
} from "../../../src/routing/key-pool.js";

const keys = (n: number): PoolKey[] =>
  Array.from({ length: n }, (_, i) => ({ id: `k${i}`, key: `sk-key-${i}`, weight: 1, revision: "r" }));

function pool(n: number) {
  let t = 1_000_000;
  const registry = new KeyStateRegistry();
  const events: KeyEvent[] = [];
  registry.onEvent((e) => events.push(e));
  const p = new KeyPool("ch", keys(n), "round_robin", 30, registry, () => t);
  return { p, events, advance: (ms: number) => (t += ms) };
}

const ACCOUNT = "402: Insufficient credits. Add more using https://openrouter.ai/settings/credits";
const REQUEST =
  "402: This request requires more credits, or fewer max_tokens. You requested up to 8000 tokens, but can only afford 1000.";

describe("402 handling (C7)", () => {
  it("classifies request-level 402s", () => {
    expect(isRequestLevel402(REQUEST)).toBe(true);
    expect(
      isRequestLevel402(
        "402: would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle",
      ),
    ).toBe(true);
    expect(isRequestLevel402(ACCOUNT)).toBe(false);
    expect(isRequestLevel402("402: Payment Required")).toBe(false);
  });

  it("a single 402 never makes the only key unusable (soft cooldown)", () => {
    const { p, events } = pool(1);
    expect(p.report("k0", 402, null, ACCOUNT)).toBe(true);
    expect(events).toEqual([expect.objectContaining({ kind: "cooldown", keyId: "k0", seconds: 30, httpStatus: 402 })]);
    expect(p.available()).toBe(true);
    expect(p.acquire().id).toBe("k0");
    // …but not for the request that just got the 402 (it was already tried).
    expect(() => p.acquire(new Set(["k0"]))).toThrow(NoUsableKeyError);
  });

  it("other keys are preferred while a key cools down after a 402", () => {
    const { p, advance } = pool(2);
    p.report("k0", 402, "120", ACCOUNT);
    expect([1, 2, 3].map(() => p.acquire().id)).toEqual(["k1", "k1", "k1"]);
    advance(121_000);
    expect(new Set([1, 2].map(() => p.acquire().id))).toEqual(new Set(["k0", "k1"]));
  });

  it("honours Retry-After, capped at one hour", () => {
    const { p, events } = pool(1);
    p.report("k0", 402, "999999", ACCOUNT);
    expect(events[0]).toMatchObject({ seconds: MAX_KEY_COOLDOWN_SECONDS });
  });

  it(`${DISABLE_AFTER_402} consecutive account-level 402s disable the key (quota)`, () => {
    const { p, events } = pool(1);
    for (let i = 0; i < DISABLE_AFTER_402; i++) p.report("k0", 402, null, ACCOUNT);
    expect(events.map((e) => e.kind)).toEqual([...Array(DISABLE_AFTER_402 - 1).fill("cooldown"), "disabled"]);
    expect(events.at(-1)).toMatchObject({ status: "quota", httpStatus: 402 });
    expect(p.available()).toBe(false);
  });

  it("a success in between resets the run of 402s", () => {
    const { p, events } = pool(1);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < DISABLE_AFTER_402 - 1; i++) p.report("k0", 402, null, ACCOUNT);
      p.reportSuccess("k0");
    }
    expect(events.some((e) => e.kind === "disabled")).toBe(false);
    expect(p.snapshot()[0]?.cooldownUntil).toBeUndefined();
  });

  it("402s spread beyond the window do not add up", () => {
    const { p, events, advance } = pool(1);
    for (let i = 0; i < DISABLE_AFTER_402 * 2; i++) {
      p.report("k0", 402, null, ACCOUNT);
      advance(PAYMENT_FAILURE_WINDOW_MS / (DISABLE_AFTER_402 - 1) + 1);
    }
    expect(events.some((e) => e.kind === "disabled")).toBe(false);
  });

  it("request-level 402s never disable the key, however many", () => {
    const { p, events } = pool(1);
    for (let i = 0; i < 20; i++) p.report("k0", 402, null, REQUEST);
    expect(events.some((e) => e.kind === "disabled")).toBe(false);
    expect(p.available()).toBe(true);
  });

  it("a 402 does not soften a running 429 cooldown", () => {
    const { p } = pool(1);
    p.report("k0", 429, "60", "429: slow down");
    p.report("k0", 402, "1", ACCOUNT);
    expect(p.available()).toBe(false);
    expect(() => p.acquire()).toThrow(NoUsableKeyError);
  });

  it("401 still disables at once", () => {
    const { p, events } = pool(1);
    p.report("k0", 401, null, "401: invalid api key");
    expect(events).toEqual([expect.objectContaining({ kind: "disabled", status: "invalid", httpStatus: 401 })]);
  });
});
