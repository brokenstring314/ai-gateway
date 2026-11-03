import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { GatewayError } from "@/core/errors";
import { KeyStore } from "@/persistence/key-store";
import { DEFAULT_RESERVATION_TTL_MS, KeyMeter, type MeteredKey, reservationTtlMs } from "@/usage/key-meter";
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

describe("KeyMeter: in-flight reservations (RB3)", () => {
  it("admits while used + reserved < quota, then 429 quota_in_flight; settle releases exactly once", () => {
    const m = new KeyMeter();
    const k = key("r1", { quotaTokens: 1000 });
    const a = m.admit(k, { reserve: () => 400 });
    const b = m.admit(k, { reserve: () => 400 });
    m.admit(k, { reserve: () => 400 }); // 800 < 1000: admitted (overshoot bounded by one request)
    expect(m.reserved("r1")).toBe(1200);
    const e = refused(() => m.admit(k, { reserve: () => 400 }));
    expect(e.status).toBe(429);
    expect(e.code).toBe("quota_in_flight");
    expect(e.retryAfter).toBe("1");
    m.settle(k, a, 300);
    m.settle(k, a, 300); // no-op
    expect(m.reserved("r1")).toBe(800);
    expect(m.used("r1")).toBe(300);
    m.settle(k, b, 0);
    expect(m.reserved("r1")).toBe(400);
  });

  it("a key without quota or TPM holds no reservation; reset keeps in-flight reservations", () => {
    const m = new KeyMeter();
    expect(m.admit(key("r2", { rpm: 10 }), { reserve: () => 999 })).toBeUndefined();
    const k = key("r3", { quotaTokens: 10_000 });
    const r = m.admit(k, { reserve: () => 500 });
    m.reset("r3");
    expect(m.reserved("r3")).toBe(500);
    m.settle(k, r, 10);
    expect(m.reserved("r3")).toBe(0);
    expect(m.used("r3")).toBe(10);
  });

  it("TPM: minute tokens + reserved ≥ TPM → 429", () => {
    const m = new KeyMeter();
    const k = key("r4", { tpm: 1000 });
    m.admit(k, { reserve: () => 600 });
    m.admit(k, { reserve: () => 600 });
    const e = refused(() => m.admit(k, { reserve: () => 1 }));
    expect(e.status).toBe(429);
    expect(e.code).toBe("rate_limit_exceeded");
  });
});

describe("KeyMeter: reservation leak safety net (RB3 follow-up)", () => {
  it("a reservation never settled expires after its TTL; the sweep runs lazily on the next admit", () => {
    const m = new KeyMeter();
    const k = key("leak1", { quotaTokens: 1000 });
    const t0 = 1_000_000;
    m.admit(k, { reserve: () => 1000, reservationTtlMs: 5_000, now: t0 }); // never settled (leaked)
    expect(m.reserved("leak1", t0)).toBe(1000);
    // Still inside the TTL: the leaked reservation holds the rest of the quota.
    expect(refused(() => m.admit(k, { reserve: () => 100, reservationTtlMs: 5_000, now: t0 + 4_999 })).code).toBe(
      "quota_in_flight",
    );
    // TTL passed: released on the next admit, which is admitted.
    const r = m.admit(k, { reserve: () => 100, reservationTtlMs: 5_000, now: t0 + 5_000 });
    expect(r?.tokens).toBe(100);
    expect(m.reserved("leak1", t0 + 5_000)).toBe(100);
    expect(m.expiredReservations()).toBe(1);
    expect(m.used("leak1")).toBe(0);
  });

  it("a late settle of an expired reservation counts its tokens and releases nothing twice", () => {
    const m = new KeyMeter();
    const k = key("leak2", { quotaTokens: 10_000 });
    const t0 = 2_000_000;
    const old = m.admit(k, { reserve: () => 500, reservationTtlMs: 1_000, now: t0 });
    const live = m.admit(k, { reserve: () => 300, reservationTtlMs: 60_000, now: t0 });
    expect(m.reserved("leak2", t0 + 1_000)).toBe(300); // old swept, live kept
    m.settle(k, old, 42, t0 + 1_500);
    expect(m.reserved("leak2", t0 + 1_500)).toBe(300);
    expect(m.used("leak2")).toBe(42);
    m.settle(k, live, 8, t0 + 1_600);
    expect(m.reserved("leak2", t0 + 1_600)).toBe(0);
    expect(m.used("leak2")).toBe(50);
    expect(m.expiredReservations()).toBe(1);
  });

  it("reset keeps open reservations and their TTL; TPM reservations expire too", () => {
    const m = new KeyMeter();
    const t0 = 3_000_000;
    const q = key("leak3", { quotaTokens: 10_000 });
    m.admit(q, { reserve: () => 700, reservationTtlMs: 1_000, now: t0 });
    m.reset("leak3");
    expect(m.reserved("leak3", t0 + 999)).toBe(700);
    expect(m.reserved("leak3", t0 + 1_000)).toBe(0);
    const t = key("leak4", { tpm: 1000 });
    m.admit(t, { reserve: () => 1000, reservationTtlMs: 1_000, now: t0 });
    expect(refused(() => m.admit(t, { reserve: () => 1, now: t0 + 10 })).code).toBe("rate_limit_exceeded");
    expect(m.admit(t, { reserve: () => 1, now: t0 + 1_000 })?.tokens).toBe(1);
  });

  it("default TTL is 1 h; reservationTtlMs() bounds it by the request lifetime", () => {
    const m = new KeyMeter();
    const k = key("leak5", { quotaTokens: 1000 });
    const r = m.admit(k, { reserve: () => 10, now: 0 });
    expect(r?.expiresAt).toBe(DEFAULT_RESERVATION_TTL_MS);
    expect(DEFAULT_RESERVATION_TTL_MS).toBe(3_600_000);
    expect(reservationTtlMs(30_000, 0)).toBe(3_600_000); // unbounded streams
    expect(reservationTtlMs(30_000, 600_000)).toBe(660_000);
    expect(reservationTtlMs(900_000, 600_000)).toBe(960_000);
  });
});
