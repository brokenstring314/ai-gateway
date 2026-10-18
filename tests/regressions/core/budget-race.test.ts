// C3-5 (fixed in 3.6). Budget used to be check-then-accrue: before_request only
// compared spent >= dailyBudget and spend was added in after_request, so N
// concurrent requests all passed the check (overshoot ~N x request cost). Now
// before_request reserves the estimated cost and the reservation is released
// when the request settles. A budget without any cost rate (every request
// costs $0) is a config error instead of silently never enforcing.
import { describe, it, expect, beforeEach } from "bun:test";
import { mk, req, tgt } from "./_h";
import { budgetSnapshot, resetBudgetStore } from "@/plugins/builtins/budget";
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import { apiKeyId } from "@/plugins/context";
beforeEach(() => resetBudgetStore());

describe("budget concurrency overshoot", () => {
  it("dailyBudget $1, each request costs $1 -> of 50 concurrent requests at most 1 succeeds", async () => {
    const { g } = mk(
      {
        strategy: { mode: "single" },
        plugins: [
          {
            name: "budget",
            stage: "before_request",
            config: { dailyBudget: 1, costPer1kInput: 0.5, costPer1kOutput: 0.5 },
          },
        ],
        targets: [tgt("a")],
      },
      ["a"],
      { a: "slow" },
      50,
    );
    const ctx = () => ({ metadata: { apiKey: "tenant-1" } }) as any;
    const res = await Promise.allSettled(Array.from({ length: 50 }, () => g.route(ctx(), req)));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1);
    const rejected = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(429);
  });

  it("reservations are released when each request settles", async () => {
    const { g } = mk(
      {
        strategy: { mode: "single" },
        plugins: [
          {
            name: "budget",
            stage: "before_request",
            config: { dailyBudget: 100, costPer1kInput: 0.5, costPer1kOutput: 0.5 },
          },
        ],
        targets: [tgt("a")],
      },
      ["a"],
      { a: "ok" },
    );
    await g.route({ metadata: { apiKey: "t" } } as any, req);
    await g.route({ metadata: { apiKey: "t" } } as any, req);
    // 2000 tokens at $0.5/1k each way = $1 spent per success; nothing left reserved.
    const snap = budgetSnapshot(apiKeyId("t"));
    expect(snap?.reserved).toBe(0);
    expect(snap?.spent).toBeCloseTo(2, 5);
  });

  it("a later plugin rejecting the request releases the reservation", async () => {
    const { g } = mk(
      {
        strategy: { mode: "single" },
        plugins: [
          {
            name: "budget",
            stage: "before_request",
            config: { dailyBudget: 100, costPer1kInput: 0.5, costPer1kOutput: 0.5 },
          },
        ],
        targets: [tgt("a")],
      },
      ["a"],
      { a: "ok" },
    );
    g.registerPlugin("before_request", {
      name: "deny",
      stage: "before_request",
      execute: async () => ({ action: "reject", reason: "no" }),
    });
    await expect(g.route({ metadata: { apiKey: "t" } } as any, req)).rejects.toThrow("no");
    expect(budgetSnapshot(apiKeyId("t"))).toEqual({ spent: 0, reserved: 0 });
  });

  it("budget configured without cost rates is a config error (validate and embedded Gateway)", () => {
    const cfg = {
      strategy: { mode: "single" },
      plugins: [{ name: "budget", stage: "before_request", config: { dailyBudget: 0.01 } }],
      targets: [tgt("a")],
    };
    expect(() => new Gateway(cfg as any)).toThrow(/budget plugin has no cost rates/);
    expect(() => loadConfigFromObject(cfg as any)).toThrow(/budget plugin has no cost rates/);
  });

  it("budget without own rates enforces with the targets' cost rates", async () => {
    const { g } = mk(
      {
        strategy: { mode: "single" },
        plugins: [{ name: "budget", stage: "before_request", config: { dailyBudget: 0.01 } }],
        targets: [tgt("a", { costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.01 })],
      },
      ["a"],
      { a: "ok" },
    );
    let ok = 0;
    for (let i = 0; i < 100; i++)
      await g.route({ metadata: { apiKey: "t" } } as any, req).then(
        () => ok++,
        () => {},
      );
    expect(ok).toBe(1); // 2000 tokens x $0.01/1k = $0.02 > $0.01 after the first request
  });
});
