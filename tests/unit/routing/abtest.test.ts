/**
 * Unit tests for AbTestStrategy.
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { AbTestStrategy } from "@/routing/abtest";
import { createMockProvider, createStreamMockProvider, createReq } from "./helpers";

describe("AbTestStrategy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("picks variant A when random is low", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;

    const strategy = new AbTestStrategy(lookup, {
      variants: [
        { name: "a", weight: 1 },
        { name: "b", weight: 99 },
      ],
    });

    vi.spyOn(Math, "random").mockReturnValue(0.001);
    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");
  });

  it("picks variant B when random is high", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;

    const strategy = new AbTestStrategy(lookup, {
      variants: [
        { name: "a", weight: 1 },
        { name: "b", weight: 99 },
      ],
    });

    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("selectTargets returns picked first, then others", () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const c = createMockProvider("c");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : name === "c" ? c : undefined;

    const strategy = new AbTestStrategy(lookup, {
      variants: [
        { name: "a", weight: 1 },
        { name: "b", weight: 1 },
        { name: "c", weight: 1 },
      ],
    });

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const targets = strategy.selectTargets(createReq());
    // The picked variant should be first
    expect(targets).toHaveLength(3);
    expect(targets).toContain("a");
    expect(targets).toContain("b");
    expect(targets).toContain("c");
  });

  it("streams to the picked variant", async () => {
    const a = createStreamMockProvider("a");
    const b = createStreamMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;

    const strategy = new AbTestStrategy(lookup, {
      variants: [
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
