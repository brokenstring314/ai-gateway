import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "../../../src/plugins/context.js";
import { RateLimitPlugin } from "../../../src/plugins/builtins/rate-limit.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../../src/providers/types.js";

function makeRequest(overrides?: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function makeContext(request?: ChatCompletionRequest) {
  return createPluginContext(request ?? makeRequest());
}

describe("RateLimitPlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("allows requests under the limit", async () => {
    const plugin = new RateLimitPlugin({ maxRequestsPerMinute: 5 });
    const ctx = makeContext();

    const result = await plugin.execute(ctx);
    expect(result.action).toBe("continue");
  });

  it("rejects when minute limit is exceeded", async () => {
    const plugin = new RateLimitPlugin({ maxRequestsPerMinute: 2 });
    const ctx = makeContext();

    // Send 2 requests (at the limit)
    await plugin.execute(ctx);
    await plugin.execute(ctx);

    // 3rd request should be rejected
    const result = await plugin.execute(ctx);
    expect(result).toEqual({
      action: "reject",
      reason: expect.stringContaining("2") as string,
    });
  });

  it("allows requests again after the minute window passes", async () => {
    const plugin = new RateLimitPlugin({ maxRequestsPerMinute: 1 });
    const ctx = makeContext();

    // First request — allowed
    const r1 = await plugin.execute(ctx);
    expect(r1.action).toBe("continue");

    // Second request within the same minute — rejected
    const r2 = await plugin.execute(ctx);
    expect(r2.action).toBe("reject");

    // Advance time by 61 seconds
    vi.advanceTimersByTime(61_000);

    // Now allowed again
    const r3 = await plugin.execute(ctx);
    expect(r3.action).toBe("continue");
  });

  it("rejects when daily limit is exceeded", async () => {
    const plugin = new RateLimitPlugin({ maxRequestsPerMinute: 100, maxRequestsPerDay: 2 });
    const ctx = makeContext();

    await plugin.execute(ctx);
    await plugin.execute(ctx);

    const result = await plugin.execute(ctx);
    expect(result.action).toBe("reject");
    expect(result).toEqual({
      action: "reject",
      reason: expect.stringContaining("2") as string,
    });
  });

  it("tracks limits per API key from metadata", async () => {
    const plugin = new RateLimitPlugin({ maxRequestsPerMinute: 1 });
    const ctx1 = makeContext();
    ctx1.metadata["api_key"] = "key-a";
    const ctx2 = makeContext();
    ctx2.metadata["api_key"] = "key-b";

    // Key A uses its limit
    const r1 = await plugin.execute(ctx1);
    expect(r1.action).toBe("continue");

    // Key A is now rate-limited
    const r2 = await plugin.execute(ctx1);
    expect(r2.action).toBe("reject");

    // Key B is still allowed
    const r3 = await plugin.execute(ctx2);
    expect(r3.action).toBe("continue");
  });

  it("uses config key as fallback when no api_key in metadata", async () => {
    const plugin = new RateLimitPlugin({ maxRequestsPerMinute: 1, key: "default-key" });
    const ctx = makeContext();
    // No api_key in metadata

    await plugin.execute(ctx);
    const result = await plugin.execute(ctx);
    expect(result.action).toBe("reject");
  });

  it("rejects with descriptive reason", async () => {
    const plugin = new RateLimitPlugin({ maxRequestsPerMinute: 3 });
    const ctx = makeContext();

    for (let i = 0; i < 3; i++) {
      await plugin.execute(ctx);
    }
    const result = await plugin.execute(ctx);
    expect(result).toEqual({
      action: "reject",
      reason: "Rate limit exceeded: 3 requests per minute",
    });
  });
});
