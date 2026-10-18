// C3-3 (fixed in 2.2: abortable limiter wait, `admitted` flag). Requests that time out while WAITING in the local concurrency-limiter queue never reach
// upstream, yet guardProvider counts them as upstream timeouts (recordFailure). Local
// congestion therefore opens the breaker of a perfectly healthy target.
import { describe, it, expect } from "bun:test";
import { mk, req, tgt, code } from "./_h";
import { createTimeoutReason } from "@/routing/outcome";

describe("limiter queue wait counted as breaker failure", () => {
  it("healthy-but-busy target gets its breaker opened by queued timeouts", async () => {
    const { g, calls } = mk({ strategy: { mode: "single" }, targets: [tgt("a", {
      circuitBreaker: { failureThreshold: 3, timeoutMs: 60_000 }, concurrency: { maxConcurrency: 1, queueSize: 100 } })] },
      ["a"], { a: "slow" }, 300);
    const withTimeout = (ms: number) => { const ac = new AbortController(); setTimeout(() => ac.abort(createTimeoutReason(ms)), ms); return { signal: ac.signal } as any; };
    // one long request holds the only slot (upstream healthy, just slow: 300ms, within its 1s timeout)
    const long = code(g.route(withTimeout(1000), req));
    // 3 more requests queue behind it and hit their (short) gateway timeout while queued
    const queued = await Promise.all([1, 2, 3].map(() => code(g.route(withTimeout(50), req))));
    expect(await long).toBe("ok:a");
    expect(queued).toEqual(["429", "429", "429"]); // queue timeout = local overload (429 gateway_overloaded)
    expect(calls["a"]).toBe(1); // ...without ever reaching upstream
    const state = g.getCircuitBreakerRegistry().get("a")!.getState();
    expect(state).toBe("CLOSED"); // was OPEN -> next requests got 503 for 60s
  });
});
