import { describe, it, expect, beforeEach } from "bun:test";
import { ConcurrencyLimiter, ConcurrencyLimitError, ConcurrencyLimiterRegistry } from "@/routing/concurrency-limiter";

describe("ConcurrencyLimiter", () => {
  it("admits requests within maxConcurrency synchronously", () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 3 });
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.inFlight).toBe(3);
    expect(limiter.queued).toBe(0);
  });

  it("queues requests beyond maxConcurrency", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1 });
    expect(limiter.acquire()).toBe(true);
    const p = limiter.acquire();
    expect(typeof p).toBe("object");
    expect(limiter.queued).toBe(1);

    limiter.release();
    await expect(p).resolves.toBe(true);
    expect(limiter.queued).toBe(0);
    expect(limiter.inFlight).toBe(1);
  });

  it("rejects when the queue is full", () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, queueSize: 1 });
    expect(limiter.acquire()).toBe(true);
    expect(typeof limiter.acquire()).toBe("object");
    expect(limiter.acquire()).toBe(false);
  });

  it("releases a slot to the next waiting request", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 2 });
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    const p1 = limiter.acquire();
    const p2 = limiter.acquire();
    expect(limiter.queued).toBe(2);

    limiter.release();
    limiter.release();
    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(true);
    expect(limiter.queued).toBe(0);
    expect(limiter.inFlight).toBe(2);
  });

  it("tracks inFlight and queued counts across acquire/release", () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 2, queueSize: 10 });
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(typeof limiter.acquire()).toBe("object");
    expect(limiter.queued).toBe(1);
    expect(limiter.inFlight).toBe(2);

    limiter.release();
    expect(limiter.queued).toBe(0);
    expect(limiter.inFlight).toBe(2);

    limiter.release();
    expect(limiter.inFlight).toBe(1);
    expect(limiter.queued).toBe(0);
  });

  it("release without in-flight requests is a no-op", () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1 });
    limiter.release();
    expect(limiter.inFlight).toBe(0);
    expect(limiter.acquire()).toBe(true);
  });

  it("rejects maxConcurrency of 0", () => {
    expect(() => new ConcurrencyLimiter({ maxConcurrency: 0 })).toThrow();
  });

  it("rejects negative maxConcurrency", () => {
    expect(() => new ConcurrencyLimiter({ maxConcurrency: -2 })).toThrow();
  });

  it("defaults queueSize to 1000", () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1 });
    expect(limiter.acquire()).toBe(true);
    for (let i = 0; i < 1000; i++) {
      expect(typeof limiter.acquire()).toBe("object");
    }
    expect(limiter.queued).toBe(1000);
    expect(limiter.acquire()).toBe(false);
  });

  it("rejects new acquisitions after close and flushes the queue", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1 });
    expect(limiter.acquire()).toBe(true);
    const p = limiter.acquire();
    limiter.close();
    expect(limiter.acquire()).toBe(false);
    await expect(p).resolves.toBe(false);
    expect(limiter.queued).toBe(0);
  });

  it("keeps independent state per instance", () => {
    const a = new ConcurrencyLimiter({ maxConcurrency: 1 });
    const b = new ConcurrencyLimiter({ maxConcurrency: 2 });
    expect(a.acquire()).toBe(true);
    expect(a.inFlight).toBe(1);
    expect(b.inFlight).toBe(0);
    expect(b.acquire()).toBe(true);
    expect(b.acquire()).toBe(true);
    expect(typeof b.acquire()).toBe("object");
    expect(b.queued).toBe(1);
  });
});

describe("ConcurrencyLimitError", () => {
  it("carries the target name in message and field", () => {
    const err = new ConcurrencyLimitError("target-a");
    expect(err.message).toContain("target-a");
    expect(err.name).toBe("ConcurrencyLimitError");
    expect(err.target).toBe("target-a");
  });
});

describe("ConcurrencyLimiterRegistry", () => {
  let registry: ConcurrencyLimiterRegistry;

  beforeEach(() => {
    registry = new ConcurrencyLimiterRegistry();
  });

  it("creates a limiter on first getOrCreate", () => {
    const limiter = registry.getOrCreate("a", { maxConcurrency: 2 });
    expect(limiter).toBeInstanceOf(ConcurrencyLimiter);
    expect(registry.get("a")).toBe(limiter);
  });

  it("reuses the same instance on subsequent getOrCreate", () => {
    const l1 = registry.getOrCreate("a", { maxConcurrency: 1 });
    const l2 = registry.getOrCreate("a", { maxConcurrency: 5 });
    expect(l1).toBe(l2);
  });

  it("keeps limiters independent per name", () => {
    const a = registry.getOrCreate("a", { maxConcurrency: 1 });
    const b = registry.getOrCreate("b", { maxConcurrency: 1 });
    expect(a).not.toBe(b);
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(true);
    expect(typeof a.acquire()).toBe("object");
    expect(b.inFlight).toBe(1);
  });

  it("get returns undefined for unknown name", () => {
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("reset removes a specific limiter", () => {
    registry.getOrCreate("a", { maxConcurrency: 1 });
    registry.reset("a");
    expect(registry.get("a")).toBeUndefined();
  });

  it("all returns every registered limiter", () => {
    registry.getOrCreate("a", { maxConcurrency: 1 });
    registry.getOrCreate("b", { maxConcurrency: 1 });
    expect(registry.all().size).toBe(2);
    expect(registry.all().has("a")).toBe(true);
    expect(registry.all().has("b")).toBe(true);
  });
});

describe("ConcurrencyLimiter abortable wait (C3-3)", () => {
  it("an aborted queued waiter leaves the queue, rejects with the abort reason and never holds a slot", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1, queueSize: 5 });
    expect(limiter.acquire()).toBe(true);
    const ac = new AbortController();
    const waiting = limiter.acquire(ac.signal) as Promise<boolean>;
    const other = limiter.acquire() as Promise<boolean>;
    expect(limiter.queued).toBe(2);
    const reason = new DOMException("t", "TimeoutError");
    ac.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(limiter.queued).toBe(1);
    limiter.release(); // hands the slot to `other`, not to the aborted waiter
    expect(await other).toBe(true);
    expect(limiter.inFlight).toBe(1);
  });

  it("an already-aborted signal rejects at once when it would queue", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1 });
    expect(limiter.acquire()).toBe(true);
    const ac = new AbortController();
    ac.abort();
    await expect(limiter.acquire(ac.signal) as Promise<boolean>).rejects.toBeDefined();
    expect(limiter.queued).toBe(0);
  });
});
