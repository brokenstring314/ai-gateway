import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { GatewayError } from "@/core/errors";
import { KeyStore } from "@/persistence/key-store";
import { KeyMeter, type MeteredKey } from "@/usage/key-meter";
import { UsageRecorder } from "@/usage/recorder";
import { UsageStore } from "@/usage/usage-store";

const key = (id: string, limits: Partial<NonNullable<MeteredKey["limits"]>> = {}, persistedUsed?: number) => ({
  id,
  limits: { quotaTokens: null, rpm: null, tpm: null, ...limits },
  ...(persistedUsed !== undefined ? { persistedUsed } : {}),
});

function refused(fn: () => void): GatewayError {
  try {
    fn();
  } catch (err) {
    if (err instanceof GatewayError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("KeyMeter: token quota", () => {
  it("refuses once used ≥ quota with 403 quota_exhausted (never 429: it does not refill)", () => {
    const m = new KeyMeter();
    const k = key("k1", { quotaTokens: 100 });
    m.admit(k);
    m.record(k, 60);
    m.admit(k); // 60 < 100
    m.record(k, 60); // the admitted request finishes past the quota: 120
    expect(m.used("k1")).toBe(120);
    const e = refused(() => m.admit(k));
    expect(e.status).toBe(403);
    expect(e.code).toBe("quota_exhausted");
    expect(e.type).toBe("insufficient_quota");
    expect(e.retryAfter).toBeUndefined();
    expect(e.message).toContain("120 of 100");
  });

  it("concurrent requests admitted before exhaustion all count; the next one is refused", () => {
    const m = new KeyMeter();
    const k = key("k1", { quotaTokens: 10 });
    // Five requests admitted while nothing was used yet (in flight together).
    for (let i = 0; i < 5; i++) m.admit(k);
    for (let i = 0; i < 5; i++) m.record(k, 7);
    expect(m.used("k1")).toBe(35);
    expect(refused(() => m.admit(k)).code).toBe("quota_exhausted");
  });

  it("quota 0 refuses at once; null quota never refuses", () => {
    const m = new KeyMeter();
    expect(refused(() => m.admit(key("z", { quotaTokens: 0 }))).code).toBe("quota_exhausted");
    const free = key("free");
    for (let i = 0; i < 100; i++) {
      m.admit(free);
      m.record(free, 1_000_000);
    }
    expect(m.used("free")).toBe(100_000_000);
  });

  it("raising the quota re-opens the key; reset() sets used back to 0", () => {
    const m = new KeyMeter();
    m.record(key("k"), 50);
    expect(refused(() => m.admit(key("k", { quotaTokens: 50 }))).code).toBe("quota_exhausted");
    m.admit(key("k", { quotaTokens: 51 }));
    m.reset("k");
    expect(m.used("k")).toBe(0);
    m.admit(key("k", { quotaTokens: 1 }));
  });

  it("a route that cannot count tokens refuses keys with a quota (403 quota_not_metered), not others", () => {
    const m = new KeyMeter();
    expect(refused(() => m.admit(key("q", { quotaTokens: 10 }), { unmetered: true })).code).toBe("quota_not_metered");
    m.admit(key("q2"), { unmetered: true });
  });

  it("restore() loads persisted counters; the persisted value on the key is used only for unseen keys", () => {
    const m = new KeyMeter();
    m.restore([["a", 500]]);
    expect(refused(() => m.admit(key("a", { quotaTokens: 500 }))).code).toBe("quota_exhausted");
    // Unseen key: its persisted used tokens (read with it at auth time) seed the counter.
    expect(refused(() => m.admit(key("b", { quotaTokens: 10 }, 10))).code).toBe("quota_exhausted");
    // Seen key: the live counter wins over a stale persisted value.
    m.reset("b");
    m.admit(key("b", { quotaTokens: 10 }, 10));
    // restore() never overwrites a live counter.
    m.record(key("a"), 1);
    m.restore([["a", 0]]);
    expect(m.used("a")).toBe(501);
  });
});

describe("KeyMeter: RPM / TPM", () => {
  it("a key's own RPM: 429 rate_limit_exceeded with Retry-After, window resets after a minute", () => {
    const m = new KeyMeter();
    const k = key("r", { rpm: 2 });
    m.admit(k, { now: 1000 });
    m.admit(k, { now: 2000 });
    const e = refused(() => m.admit(k, { now: 3000 }));
    expect(e.status).toBe(429);
    expect(e.code).toBe("rate_limit_exceeded");
    expect(Number(e.retryAfter)).toBe(58);
    m.admit(k, { now: 61_000 });
  });

  it("TPM counts tokens of completed requests in the window; own TPM beats the global value", () => {
    const m = new KeyMeter();
    const own = key("t", { tpm: 100 });
    m.admit(own, { globalTpm: 10, now: 0 });
    m.record(own, 60, 10);
    m.admit(own, { globalTpm: 10, now: 20 }); // 60 < 100 (the global 10 does not apply)
    m.record(own, 60, 30);
    expect(refused(() => m.admit(own, { globalTpm: 10, now: 40 })).message).toContain("100 tokens per minute");
    m.admit(own, { globalTpm: 10, now: 60_001 });
  });

  it("keys without their own TPM use the global TPM (rate-limit plugin maxTokensPerMinute)", () => {
    const m = new KeyMeter();
    const k = key("g");
    m.admit(k, { globalTpm: 50, now: 0 });
    m.record(k, 50, 1);
    expect(refused(() => m.admit(k, { globalTpm: 50, now: 2 })).message).toContain("50 tokens per minute");
    // Without a global TPM nothing limits it.
    m.admit(k, { now: 3 });
    // Unauthenticated callers share one bucket.
    m.record(undefined, 50, 4);
    expect(refused(() => m.admit(undefined, { globalTpm: 50, now: 5 })).status).toBe(429);
  });
});

describe("KeyMeter persistence", () => {
  it("dirty counters are written by the recorder and restored after a restart", async () => {
    const db = new Database(":memory:");
    const ks = await KeyStore.create(db);
    const created = ks.create("limited", ["inference"], undefined, { quotaTokens: 100 });
    const m = new KeyMeter();
    const usage = await UsageStore.create(new Database(":memory:"));
    const rec = new UsageRecorder({ store: usage, meter: m, keyStore: ks, intervalMs: 0 });
    m.record({ id: created.id }, 42);
    expect(ks.get(created.id)!.usedTokens).toBe(0); // nothing written on the request path
    rec.flush();
    expect(ks.get(created.id)!.usedTokens).toBe(42);
    expect(m.drainDirty()).toEqual([]);
    // "Restart": a new meter restored from the key store.
    const m2 = new KeyMeter();
    m2.restore(ks.usedTokensByKey());
    expect(m2.used(created.id)).toBe(42);
    rec.close();
  });

  it("a failed persist keeps the counter dirty for the next flush", async () => {
    const m = new KeyMeter();
    const usage = await UsageStore.create(new Database(":memory:"));
    let fail = true;
    const saved: Array<[string, number]> = [];
    const rec = new UsageRecorder({
      store: usage,
      meter: m,
      keyStore: {
        saveUsedTokens: (e) => {
          if (fail) throw new Error("disk full");
          saved.push(...[...e].map(([a, b]) => [a, b] as [string, number]));
        },
      },
      intervalMs: 0,
    });
    m.record({ id: "x" }, 5);
    rec.flush();
    fail = false;
    rec.flush();
    expect(saved).toEqual([["x", 5]]);
  });
});
