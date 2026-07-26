/**
 * Unit tests for LeastLatencyStrategy.
 */

import { describe, it, expect } from "vitest";
import { LeastLatencyStrategy } from "@/routing/least-latency";
import { createMockProvider, createReq } from "./helpers";

describe("LeastLatencyStrategy", () => {
  it("uses first target when no latency data exists", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;

    const strategy = new LeastLatencyStrategy(lookup, {
      targets: ["a", "b"],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    // With no data, p50 is 0 for both; sorted alphabetically? Actually sort is stable, so first stays first
    expect(resp.provider).toBe("a");
  });

  it("picks the target with lower recorded latency", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;

    const strategy = new LeastLatencyStrategy(lookup, {
      targets: ["a", "b"],
    });

    // Record some calls to build up latency data
    await strategy.execute({ metadata: {} }, createReq()); // a = first
    await strategy.execute({ metadata: {} }, createReq()); // now a has some latency

    // After recording, the p50 of a is non-zero, b is still 0, so b should be picked
    const resp = await strategy.execute({ metadata: {} }, createReq());
    // b should be picked since its p50 is still 0
    expect(resp.provider).toBe("b");
  });

  it("selectTargets returns targets sorted by latency ascending", () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;

    const strategy = new LeastLatencyStrategy(lookup, {
      targets: ["a", "b"],
    });

    const targets = strategy.selectTargets(createReq());
    expect(targets).toEqual(["a", "b"]);
  });
});
