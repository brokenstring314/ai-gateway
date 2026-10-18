/**
 * Unit tests for LoadBalanceStrategy.
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { createMockProvider, createStreamMockProvider, createReq } from "./helpers";
import { boundLoadBalance } from "./helpers";

describe("LoadBalanceStrategy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("picks a target weighted by weight", () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) => (name === "a" ? a : name === "b" ? b : undefined);

    const strategy = boundLoadBalance(lookup, {
      targets: [
        { name: "a", weight: 1 },
        { name: "b", weight: 99 },
      ],
    });

    // When random is very high, pick b (the heavy one)
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const targets = strategy.selectTargets(createReq());
    expect(targets[0]).toBe("b");
  });

  it("returns all targets in selectTargets with weight-ordered shuffle", () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) => (name === "a" ? a : name === "b" ? b : undefined);

    const strategy = boundLoadBalance(lookup, {
      targets: [
        { name: "a", weight: 1 },
        { name: "b", weight: 99 },
      ],
    });

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const targets = strategy.selectTargets(createReq());
    expect(targets).toHaveLength(2);
    expect(targets).toContain("a");
    expect(targets).toContain("b");
  });

  it("executes through the picked provider", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) => (name === "a" ? a : name === "b" ? b : undefined);

    const strategy = boundLoadBalance(lookup, {
      targets: [
        { name: "a", weight: 1 },
        { name: "b", weight: 99 },
      ],
    });

    vi.spyOn(Math, "random").mockReturnValue(0.001);
    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");
  });

  it("streams through the picked provider", async () => {
    const a = createStreamMockProvider("a");
    const b = createStreamMockProvider("b");
    const lookup = (name: string) => (name === "a" ? a : name === "b" ? b : undefined);

    const strategy = boundLoadBalance(lookup, {
      targets: [
        { name: "a", weight: 1 },
        { name: "b", weight: 99 },
      ],
    });

    vi.spyOn(Math, "random").mockReturnValue(0.001);
    const chunks: unknown[] = [];
    for await (const chunk of strategy.executeStream({ metadata: {} }, createReq())) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
  });
});
