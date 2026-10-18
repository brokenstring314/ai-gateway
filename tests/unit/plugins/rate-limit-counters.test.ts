// S3-8 / C3-8 regression: the rate-limit plugin must use O(1) counters, not
// per-request timestamp arrays, must not track a day window when no daily
// limit is set, and must evict idle keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { RateLimitPlugin } from "@/plugins/builtins/rate-limit";
import { createPluginContext } from "@/plugins/context";

function ctxFor(key: string) {
  const ctx = createPluginContext({ model: "m", messages: [] } as never);
  ctx.metadata["api_key"] = key;
  return ctx;
}

type Internals = { windows: Map<string, { minute: unknown; day: unknown }> };

describe("S3-8 rate-limit counters", () => {
  it("without maxRequestsPerDay no day window is kept", async () => {
    const p = new RateLimitPlugin({ maxRequestsPerMinute: 1000 });
    for (let i = 0; i < 500; i++) await p.execute(ctxFor("k"));
    const state = (p as unknown as Internals).windows.get("k");
    expect(state?.day).toBeNull();
    expect(JSON.stringify(state).length).toBeLessThan(200); // constant-size state, no arrays
  });

  it("per-request cost does not grow with request volume", async () => {
    const p = new RateLimitPlugin({ maxRequestsPerMinute: 10_000_000, maxRequestsPerDay: 10_000_000 });
    const ctx = ctxFor("k");
    const time = async (n: number) => {
      const t = performance.now();
      for (let i = 0; i < n; i++) await p.execute(ctx);
      return (performance.now() - t) / n;
    };
    const early = await time(2000);
    for (let i = 0; i < 30; i++) await time(2000);
    const late = await time(2000);
    expect(late).toBeLessThan(Math.max(early * 5, 0.05));
  }, 30_000);
});

describe("rate-limit windows and eviction (fake time)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("daily limit holds across minute windows and resets after 24h", async () => {
    const p = new RateLimitPlugin({ maxRequestsPerMinute: 10, maxRequestsPerDay: 3 });
    const ctx = ctxFor("k");
    for (let i = 0; i < 3; i++) {
      expect((await p.execute(ctx)).action).toBe("continue");
      vi.advanceTimersByTime(61_000);
    }
    expect((await p.execute(ctx)).action).toBe("reject");
    vi.advanceTimersByTime(86_400_000);
    expect((await p.execute(ctx)).action).toBe("continue");
  });

  it("idle keys are evicted", async () => {
    const p = new RateLimitPlugin({ maxRequestsPerMinute: 5 });
    for (let i = 0; i < 100; i++) await p.execute(ctxFor(`key-${i}`));
    expect(p.trackedKeys).toBe(100);
    vi.advanceTimersByTime(2 * 60_000);
    await p.execute(ctxFor("fresh"));
    expect(p.trackedKeys).toBe(1);
  });

  it("keys with a live day window are kept until it expires", async () => {
    const p = new RateLimitPlugin({ maxRequestsPerMinute: 5, maxRequestsPerDay: 5 });
    await p.execute(ctxFor("a"));
    vi.advanceTimersByTime(2 * 60_000);
    await p.execute(ctxFor("b"));
    expect(p.trackedKeys).toBe(2);
    vi.advanceTimersByTime(86_400_000);
    await p.execute(ctxFor("c"));
    expect(p.trackedKeys).toBe(1);
  });
});
