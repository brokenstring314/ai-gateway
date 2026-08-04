/**
 * Unit tests for LeastLatencyStrategy.
 */

import { describe, it, expect } from "vitest";
import { LeastLatencyStrategy } from "@/routing/least-latency";
import type { ChatCompletionResponse, RequestContext } from "@/providers/types";
import { createMockProvider, createReq } from "./helpers";

/** Mock provider whose complete() resolves after a deterministic delay. */
function createDelayedProvider(
  name: string,
  delayMs: number,
): ReturnType<typeof createMockProvider> {
  const base = createMockProvider(name);
  return {
    ...base,
    complete: async (
      ctx: RequestContext,
      req: Parameters<ReturnType<typeof createMockProvider>["complete"]>[1],
    ): Promise<ChatCompletionResponse> => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return base.complete(ctx, req);
    },
  };
}

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
    // Deterministic latency: "a" is slow (10ms), "b" is fast (1ms).
    const a = createDelayedProvider("a", 10);
    const b = createDelayedProvider("b", 1);
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;

    const strategy = new LeastLatencyStrategy(lookup, {
      targets: ["a", "b"],
    });

    // Call 1: no data — falls back to the first declared target ("a"),
    // recording its slow latency.
    await strategy.execute({ metadata: {} }, createReq());
    // Call 2: "b" is unseen (p50 0) and "a" now has samples — "b" is picked
    // and its fast latency is recorded.
    await strategy.execute({ metadata: {} }, createReq());
    // Call 3: both sampled — "b" has the lower p50 and must win.
    const resp = await strategy.execute({ metadata: {} }, createReq());
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
