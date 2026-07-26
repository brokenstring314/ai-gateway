/**
 * Unit tests for CostOptimizedStrategy.
 */

import { describe, it, expect } from "vitest";
import { CostOptimizedStrategy } from "@/routing/cost-optimized";
import { createMockProvider, createStreamMockProvider, createReq } from "./helpers";

describe("CostOptimizedStrategy", () => {
  it("picks the cheapest target", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = new CostOptimizedStrategy(lookup, {
      targets: [
        { name: "openai", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 },
        { name: "groq", costPer1kInputTokens: 0.0002, costPer1kOutputTokens: 0.0005 },
      ],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("groq");
  });

  it("returns targets sorted by cost in selectTargets", () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = new CostOptimizedStrategy(lookup, {
      targets: [
        { name: "openai", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 },
        { name: "groq", costPer1kInputTokens: 0.0002, costPer1kOutputTokens: 0.0005 },
      ],
    });

    expect(strategy.selectTargets(createReq())).toEqual(["groq", "openai"]);
  });

  it("streams to the cheapest target", async () => {
    const openai = createStreamMockProvider("openai");
    const groq = createStreamMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = new CostOptimizedStrategy(lookup, {
      targets: [
        { name: "openai", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 },
        { name: "groq", costPer1kInputTokens: 0.0002, costPer1kOutputTokens: 0.0005 },
      ],
    });

    const chunks: unknown[] = [];
    for await (const chunk of strategy.executeStream({ metadata: {} }, createReq())) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
  });

  it("throws when no targets are priced", async () => {
    const lookup = () => undefined;
    const strategy = new CostOptimizedStrategy(lookup, { targets: [] });

    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("no priced targets");
  });

  it("routes to cheapest provider that supports the model", async () => {
    const cheap = createMockProvider("cheap");
    const expensive = createMockProvider("expensive");
    const lookup = (name: string) =>
      name === "cheap" ? cheap : name === "expensive" ? expensive : undefined;

    const strategy = new CostOptimizedStrategy(lookup, {
      targets: [
        { name: "expensive", costPer1kInputTokens: 0.05, costPer1kOutputTokens: 0.10 },
        { name: "cheap", costPer1kInputTokens: 0.001, costPer1kOutputTokens: 0.002 },
      ],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("cheap");
  });

  it("falls back to unpriced providers when none have prices", async () => {
    const free = createMockProvider("free");
    const lookup = (name: string) => name === "free" ? free : undefined;

    const strategy = new CostOptimizedStrategy(lookup, {
      targets: [
        { name: "free", costPer1kInputTokens: 0, costPer1kOutputTokens: 0 },
      ],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("free");
  });

  it("sorts by input cost first, then output cost as tiebreaker", () => {
    const lookup = (name: string) => createMockProvider(name);
    const strategy = new CostOptimizedStrategy(lookup, {
      targets: [
        { name: "a", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.10 },
        { name: "b", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.05 },
      ],
    });

    expect(strategy.selectTargets(createReq())).toEqual(["b", "a"]);
  });
});
