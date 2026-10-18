// Model-based randomized interleaving test for CircuitBreaker (cd0c1fa).
// Ops: acquire, settle(permit, success|failure|release), advance clock.
// Invariants checked after every step:
//   I1 0 <= halfOpenPermits <= maxHalfThreshold
//   I2 liveness: once every permit is settled and >= timeoutMs passes, acquire() succeeds
//   I3 a breaker that went OPEN may only become CLOSED after a success reported by a
//      permit admitted in HALF_OPEN (a probe). Successes from permits admitted while
//      CLOSED (i.e. before the outage) must not close it.
//   I4 a stale (pre-OPEN, CLOSED-era) failure must not re-arm/extend the OPEN window.
import { describe, it, expect, setSystemTime, afterEach } from "bun:test";
import { CircuitBreaker, type BreakerPermit } from "@/routing/circuit-breaker";

afterEach(() => setSystemTime());

function rng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

type Viol = { seed: number; step: number; inv: string; trace: string[] };

function run(seed: number, steps = 200): Viol | null {
  const r = rng(seed);
  let now = 1_000_000;
  setSystemTime(new Date(now));
  const cfg = {
    failureThreshold: 1 + Math.floor(r() * 3),
    successThreshold: 1 + Math.floor(r() * 3),
    maxHalfThreshold: 1 + Math.floor(r() * 3),
    timeoutMs: 100,
  };
  const b = new CircuitBreaker("t", cfg);
  const out: { p: BreakerPermit; stateAtAcquire: string }[] = [];
  const trace: string[] = [JSON.stringify(cfg)];
  for (let step = 0; step < steps; step++) {
    const x = r();
    if (x < 0.35) {
      const st = b.getState();
      const p = b.acquire();
      trace.push(`acquire@${st} -> ${p ? JSON.stringify(p) : "null"}`);
      if (p) out.push({ p, stateAtAcquire: st });
    } else if (x < 0.8 && out.length) {
      const i = Math.floor(r() * out.length);
      const { p, stateAtAcquire } = out.splice(i, 1)[0]!;
      const k = r();
      const before = b.getState();
      const openedAtBefore = (b as any).openedAt;
      if (k < 0.4) {
        b.recordSuccess(p);
        trace.push(`success(${stateAtAcquire} permit) ${before}->${b.getState()}`);
        if (before !== "CLOSED" && b.getState() === "CLOSED" && !p.halfOpen)
          return { seed, step, inv: "I3 non-probe success closed breaker", trace };
      } else if (k < 0.75) {
        b.recordFailure(p);
        trace.push(`failure(${stateAtAcquire} permit) ${before}->${b.getState()}`);
        if (before === "OPEN" && !p.halfOpen && (b as any).openedAt !== openedAtBefore)
          return { seed, step, inv: "I4 stale failure extended OPEN window", trace };
      } else {
        b.release(p);
        trace.push(`release(${JSON.stringify(p)}) ${before}->${b.getState()}`);
      }
    } else {
      now += Math.floor(r() * 120);
      setSystemTime(new Date(now));
      trace.push(`t+=.. now=${now}`);
    }
    const hp = (b as any).halfOpenPermits as number;
    if (hp < 0 || hp > cfg.maxHalfThreshold) return { seed, step, inv: `I1 halfOpenPermits=${hp}`, trace };
    if (out.length === 0) {
      // liveness probe on a clone-free check: advance 2*timeout and ensure acquire works, then release it
      const saveNow = now;
      setSystemTime(new Date(now + 2 * cfg.timeoutMs));
      const p = b.acquire();
      if (!p) return { seed, step, inv: "I2 stuck: no permit after all settled + 2*timeout", trace };
      b.release(p);
      setSystemTime(new Date(saveNow));
      // note: acquire may have moved OPEN->HALF_OPEN in the future; accept
    }
  }
  return null;
}

describe("CircuitBreaker randomized state-machine", () => {
  it("I1/I2 hold (no negative/overflow permits, never stuck) over 5000 random schedules", () => {
    const bad: Viol[] = [];
    for (let s = 1; s <= 5000; s++) {
      const v = run(s);
      if (v && (v.inv.startsWith("I1") || v.inv.startsWith("I2"))) bad.push(v);
    }
    if (bad.length) console.log(bad[0]!.inv, bad[0]!.trace.slice(-12).join("\n"));
    expect(bad.length).toBe(0);
  });
  // C3-6 fixed in 2.2: settlement takes the permit (recordSuccess(p) / recordFailure(p)).
  it("I3/I4: stale (pre-outage) outcomes must not decide the HALF_OPEN/OPEN state", () => {
    const bad: Viol[] = [];
    for (let s = 1; s <= 5000; s++) {
      const v = run(s);
      if (v && (v.inv.startsWith("I3") || v.inv.startsWith("I4"))) bad.push(v);
    }
    if (bad.length)
      console.log(`${bad.length} schedules violate; first:`, bad[0]!.inv, "\n" + bad[0]!.trace.slice(-10).join("\n"));
    expect(bad.length).toBe(0);
  });
});
