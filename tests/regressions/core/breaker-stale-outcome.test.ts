// C3-? recordSuccess()/recordFailure() ignore the permit: outcomes of attempts that were
// admitted while CLOSED (before the outage) decide HALF_OPEN/OPEN transitions.
import { describe, it, expect, setSystemTime, afterEach } from "bun:test";
import { CircuitBreaker } from "@/routing/circuit-breaker";
afterEach(() => setSystemTime());

describe("breaker stale outcomes", () => {
  it.failing("a pre-outage request finishing late closes the breaker without any probe", () => {
    let t = 1_000_000; setSystemTime(new Date(t));
    const b = new CircuitBreaker("a", { failureThreshold: 2, successThreshold: 3, timeoutMs: 1000 });
    const longStream = b.acquire()!;            // long generation started while healthy
    b.acquire(); b.recordFailure(); b.acquire(); b.recordFailure(); // upstream dies -> OPEN
    expect(b.getState()).toBe("OPEN");
    setSystemTime(new Date(t += 1000));
    expect(b.getState()).toBe("HALF_OPEN");     // no probe sent yet
    // the old stream ends now: 3 such stale successes (successThreshold=3) close the breaker
    void longStream; b.recordSuccess(); b.recordSuccess(); b.recordSuccess();
    expect(b.getState()).toBe("HALF_OPEN");     // FAILS: CLOSED, no probe ever ran
  });
  it.failing("a pre-outage request failing late keeps pushing the OPEN window forward", () => {
    let t = 1_000_000; setSystemTime(new Date(t));
    const b = new CircuitBreaker("a", { failureThreshold: 1, timeoutMs: 1000 });
    const inflight = Array.from({ length: 10 }, () => b.acquire()!); // 10 in-flight when it dies
    b.recordFailure();                          // -> OPEN at t
    for (let i = 0; i < 9; i++) { setSystemTime(new Date(t += 900)); b.recordFailure(); } // stragglers time out one by one
    void inflight;
    setSystemTime(new Date(1_000_000 + 1000 * 2));
    expect(b.getState()).not.toBe("OPEN");      // FAILS: still OPEN ~9s after a 1s timeoutMs
  });
});
