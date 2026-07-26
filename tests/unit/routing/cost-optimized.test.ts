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
});
