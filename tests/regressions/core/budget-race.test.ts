// Budget plugin is check-then-accrue: before_request only compares spent>=dailyBudget,
// spend is added in after_request. N concurrent requests all pass the check -> the daily
// budget is overshot by ~N x request cost (unbounded with concurrency).
import { describe, it, expect, beforeEach } from "bun:test";
import { mk, req, tgt } from "./_h";
import { resetBudgetStore } from "@/plugins/builtins/budget";
beforeEach(() => resetBudgetStore());

describe("budget concurrency overshoot", () => {
  it.failing("dailyBudget $1, each request costs $1 -> 50 concurrent requests all succeed ($50 spent)", async () => {
    const { g } = mk({ strategy: { mode: "single" }, plugins: [{ name: "budget", stage: "before_request", config: { dailyBudget: 1, costPer1kInput: 0.5, costPer1kOutput: 0.5 } }],
      targets: [tgt("a")] }, ["a"], { a: "slow" }, 50);
    const ctx = () => ({ metadata: { apiKey: "tenant-1" } }) as any;
    const res = await Promise.allSettled(Array.from({ length: 50 }, () => g.route(ctx(), req)));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    console.log("succeeded:", ok, "(each = $1 against a $1 daily budget)");
    expect(ok).toBeLessThanOrEqual(1); // FAILS: 50
  });
  it.failing("budget configured without cost rates silently never enforces anything", async () => {
    const { g } = mk({ strategy: { mode: "single" }, plugins: [{ name: "budget", stage: "before_request", config: { dailyBudget: 0.01 } }],
      targets: [tgt("a")] }, ["a"], { a: "ok" });
    let ok = 0;
    for (let i = 0; i < 100; i++) await g.route({ metadata: { apiKey: "t" } } as any, req).then(() => ok++, () => {});
    console.log("succeeded:", ok, "of 100 with dailyBudget 0.01 (2000 tokens each)");
    expect(ok).toBeLessThan(100); // FAILS: 100 - cost defaults to 0, config accepted without warning
  });
});
