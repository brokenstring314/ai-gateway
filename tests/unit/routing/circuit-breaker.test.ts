import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitBreaker, CircuitOpenError, CircuitBreakerRegistry } from "@/routing/circuit-breaker";

describe("CircuitBreaker", () => {
  it("starts in CLOSED state, allows all requests", () => {
    const cb = new CircuitBreaker("test");
    expect(cb.allow()).toBe(true);
  });

  it("transitions to OPEN after failureThreshold consecutive failures", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allow()).toBe(true);
    cb.recordFailure();
    expect(cb.allow()).toBe(false);
  });

  it("rejects requests in OPEN state with CircuitOpenError", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.allow()).toBe(false);
  });

  it("transitions to HALF_OPEN after timeout", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker("test", { failureThreshold: 1, timeoutMs: 1000 });
    cb.recordFailure();
    expect(cb.allow()).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(cb.allow()).toBe(true);
    vi.useRealTimers();
  });

  it("allows one probe in HALF_OPEN; success transitions to CLOSED", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker("test", { failureThreshold: 1, timeoutMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.allow()).toBe(true);

    cb.recordSuccess();
    expect(cb.allow()).toBe(true);
    vi.useRealTimers();
  });

  it("HALF_OPEN failure transitions back to OPEN", () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker("test", { failureThreshold: 1, timeoutMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.allow()).toBe(true);

    cb.recordFailure();
    expect(cb.allow()).toBe(false);
    vi.useRealTimers();
  });

  it("success resets failure count in CLOSED state", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allow()).toBe(true);
  });

  it("uses default config when none provided", () => {
    const cb = new CircuitBreaker("test");
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.allow()).toBe(false);
  });
});

describe("CircuitOpenError", () => {
  it("includes target name in message", () => {
    const err = new CircuitOpenError("my-target");
    expect(err.message).toContain("my-target");
    expect(err.name).toBe("CircuitOpenError");
    expect(err.target).toBe("my-target");
  });
});

describe("CircuitBreakerRegistry", () => {
  let registry: CircuitBreakerRegistry;

  beforeEach(() => {
    registry = new CircuitBreakerRegistry();
  });

  it("creates breaker on first getOrCreate", () => {
    const cb = registry.getOrCreate("test", { failureThreshold: 2 });
    expect(cb).toBeInstanceOf(CircuitBreaker);
    expect(cb.name).toBe("test");
  });

  it("returns same breaker on subsequent getOrCreate", () => {
    const cb1 = registry.getOrCreate("test");
    const cb2 = registry.getOrCreate("test");
    expect(cb1).toBe(cb2);
  });

  it("get returns undefined for unknown name", () => {
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("reset removes a specific breaker", () => {
    registry.getOrCreate("test");
    registry.reset("test");
    expect(registry.get("test")).toBeUndefined();
  });

  it("resetAll clears all breakers", () => {
    registry.getOrCreate("a");
    registry.getOrCreate("b");
    registry.resetAll();
    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("b")).toBeUndefined();
  });

  it("all returns all breakers", () => {
    registry.getOrCreate("a");
    registry.getOrCreate("b");
    expect(registry.all().size).toBe(2);
  });
});
