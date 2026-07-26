/**
 * Unit tests for FallbackStrategy.
 */

import { describe, it, expect } from "vitest";
import {
  FallbackStrategy,
  FallbackExhaustedError,
} from "@/routing/fallback";
import { createMockProvider, createStreamMockProvider, createReq, createFailingProvider } from "./helpers";

describe("FallbackStrategy", () => {
  it("selects all targets in order", () => {
    const a = createMockProvider("a");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? createMockProvider("b") : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
    });

    expect(strategy.selectTargets(createReq())).toEqual(["a", "b"]);
  });

  it("routes to first target when it succeeds", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");
  });

  it("falls back to second target when first fails", async () => {
    const a = createFailingProvider("a", new Error("down"));
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("throws FallbackExhaustedError when all targets fail", async () => {
    const a = createFailingProvider("a", new Error("down"));
    const b = createFailingProvider("b", new Error("also down"));
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
    });

    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow(FallbackExhaustedError);
  });

  it("skips targets that are not registered", async () => {
    const b = createMockProvider("b");
    const lookup = (name: string) => (name === "b" ? b : undefined);
    const strategy = new FallbackStrategy(lookup, {
      targets: ["missing", "b"],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("falls back in streaming mode on failure", async () => {
    const a = createFailingProvider("a", new Error("down"));
    const b = createStreamMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
    });

    const chunks: unknown[] = [];
    for await (const chunk of strategy.executeStream({ metadata: {} }, createReq())) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
  });
});
