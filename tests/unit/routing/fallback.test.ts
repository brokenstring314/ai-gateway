/**
 * Unit tests for FallbackStrategy.
 */

import { describe, it, expect, vi } from "bun:test";
import {
  FallbackStrategy,
  FallbackExhaustedError,
} from "@/routing/fallback";
import { createMockProvider, createStreamMockProvider, createReq, createFailingProvider } from "./helpers";

function createStatusErrorProvider(name: string, statusCode: number) {
  const err: Error & { statusCode: number } = new Error(`status ${statusCode}`) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return createFailingProvider(name, err);
}

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

  it("throws immediately on 4xx error (except 429)", async () => {
    const a = createStatusErrorProvider("a", 400);
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
    });

    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("status 400");
  });

  it("retries on 429 and falls back", async () => {
    const a = createStatusErrorProvider("a", 429);
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
      retryConfigs: new Map([["a", { attempts: 1, initialBackoffMs: 1 }]]),
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("retries on 5xx and falls back", async () => {
    const a = createStatusErrorProvider("a", 500);
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
      retryConfigs: new Map([["a", { attempts: 1, initialBackoffMs: 1 }]]),
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("logs each failure to console.error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = createFailingProvider("a", new Error("down"));
    const b = createMockProvider("b");
    const lookup = (name: string) =>
      name === "a" ? a : name === "b" ? b : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a", "b"],
      retryConfigs: new Map([["a", { attempts: 1, initialBackoffMs: 1 }]]),
    });

    await strategy.execute({ metadata: {} }, createReq());
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("FallbackStrategy"),
      expect.any(String),
    );
    spy.mockRestore();
  });

  it("FallbackExhaustedError includes cause", async () => {
    const cause = new Error("root cause");
    const a = createFailingProvider("a", cause);
    const lookup = (name: string) => name === "a" ? a : undefined;
    const strategy = new FallbackStrategy(lookup, {
      targets: ["a"],
      retryConfigs: new Map([["a", { attempts: 1, initialBackoffMs: 1 }]]),
    });

    try {
      await strategy.execute({ metadata: {} }, createReq());
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FallbackExhaustedError);
      expect((err as FallbackExhaustedError).cause).toBeDefined();
    }
  });
});
