import { describe, it, expect } from "bun:test";
import { CircuitBreaker } from "@/routing/circuit-breaker";
import { isBreakerFailure, isTimeoutAbort, createTimeoutReason } from "@/routing/outcome";
import { ProviderError } from "@/providers/openai-compat";

const trip = async (b: CircuitBreaker, ms: number) => {
  b.recordFailure();
  expect(b.getState()).toBe("OPEN");
  await Bun.sleep(ms);
};

describe("CircuitBreaker.release", () => {
  it("returns the HALF_OPEN probe permit", async () => {
    const b = new CircuitBreaker("t", { failureThreshold: 1, timeoutMs: 30 });
    await trip(b, 40);
    const p = b.acquire();
    expect(p?.halfOpen).toBe(true);
    expect(b.allow()).toBe(false);
    b.release(p);
    expect(b.allow()).toBe(true);
  });

  it("ignores a permit from a CLOSED attempt or a previous probe window", async () => {
    const b = new CircuitBreaker("t", { failureThreshold: 1, timeoutMs: 30 });
    const closedPermit = b.acquire();
    await trip(b, 40);
    const probe = b.acquire();
    b.release(closedPermit);
    expect(b.allow()).toBe(false);
    b.recordFailure(); // probe failed -> OPEN, new window later
    await Bun.sleep(40);
    expect(b.allow()).toBe(true);
    b.release(probe); // stale epoch
    expect(b.allow()).toBe(false);
  });

  it("re-arms a leaked probe permit after timeoutMs", async () => {
    const b = new CircuitBreaker("t", { failureThreshold: 1, timeoutMs: 30 });
    await trip(b, 40);
    expect(b.allow()).toBe(true); // probe never reports back
    expect(b.allow()).toBe(false);
    await Bun.sleep(40);
    expect(b.allow()).toBe(true);
  });

  it("frees the slot after a HALF_OPEN success when more successes are needed", async () => {
    const b = new CircuitBreaker("t", { failureThreshold: 1, successThreshold: 2, timeoutMs: 30 });
    await trip(b, 40);
    expect(b.allow()).toBe(true);
    b.recordSuccess();
    expect(b.getState()).toBe("HALF_OPEN");
    expect(b.allow()).toBe(true);
    b.recordSuccess();
    expect(b.getState()).toBe("CLOSED");
  });
});

describe("breaker outcome helpers", () => {
  it("counts only health-related errors", () => {
    for (const s of [0, 401, 403, 408, 429, 500, 502, 503, 504]) expect(isBreakerFailure(new ProviderError("a", s, "x"))).toBe(true);
    for (const s of [400, 404, 409, 413, 422]) expect(isBreakerFailure(new ProviderError("a", s, "x"))).toBe(false);
    expect(isBreakerFailure(new Error("socket hang up"))).toBe(true);
  });

  it("tells the request timeout apart from a client abort", () => {
    const t = new AbortController();
    t.abort(createTimeoutReason(10));
    expect(isTimeoutAbort(t.signal)).toBe(true);
    const c = new AbortController();
    c.abort();
    expect(isTimeoutAbort(c.signal)).toBe(false);
    expect(isTimeoutAbort(undefined)).toBe(false);
  });
});
