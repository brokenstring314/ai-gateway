import { beforeEach, describe, expect, it, vi } from "bun:test";
import { createPluginContext } from "../../../src/plugins/context.js";
import { CachePlugin } from "../../../src/plugins/builtins/cache.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../../src/providers/types.js";

function makeRequest(overrides?: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function makeResponse(overrides?: Partial<ChatCompletionResponse>): ChatCompletionResponse {
  return {
    id: "resp-1",
    object: "chat.completion",
    created: Date.now(),
    model: "test-model",
    provider: "test",
    choices: [
      { index: 0, message: { role: "assistant", content: "hi" }, finishReason: "stop" },
    ],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    ...overrides,
  };
}

describe("CachePlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns continue on cache miss (before_request)", async () => {
    const cache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const ctx = createPluginContext(makeRequest());

    const result = await cache.execute(ctx);
    expect(result.action).toBe("continue");
  });

  it("stores the cache key in metadata on miss", async () => {
    const cache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const ctx = createPluginContext(makeRequest());

    await cache.execute(ctx);
    expect(ctx.metadata["_cacheKey"]).toBeTypeOf("string");
  });

  it("returns short_circuit on cache hit", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const afterCache = new CachePlugin({ ttlSeconds: 60 }, "after_request");
    const response = makeResponse();

    // First: before_request (miss) + after_request (store)
    const ctx1 = createPluginContext(makeRequest());
    await beforeCache.execute(ctx1);
    ctx1.response = response;
    await afterCache.execute(ctx1);

    // Second request with same messages — should hit cache
    const ctx2 = createPluginContext(makeRequest());
    const result = await beforeCache.execute(ctx2);
    expect(result.action).toBe("short_circuit");
    if (result.action === "short_circuit") {
      expect(result.response.id).toBe(response.id);
    }
  });

  it("different requests produce different cache keys", async () => {
    const cache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const ctx1 = createPluginContext(makeRequest({ model: "model-a" }));
    const ctx2 = createPluginContext(makeRequest({ model: "model-b" }));

    await cache.execute(ctx1);
    await cache.execute(ctx2);

    expect(ctx1.metadata["_cacheKey"]).not.toBe(ctx2.metadata["_cacheKey"]);
  });

  it("cache expires after TTL", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const afterCache = new CachePlugin({ ttlSeconds: 60 }, "after_request");
    const response = makeResponse();

    // Store in cache
    const ctx1 = createPluginContext(makeRequest());
    await beforeCache.execute(ctx1);
    ctx1.response = response;
    await afterCache.execute(ctx1);

    // Advance past TTL
    vi.advanceTimersByTime(61_000);

    // Should miss now
    const ctx2 = createPluginContext(makeRequest());
    const result = await beforeCache.execute(ctx2);
    expect(result.action).toBe("continue");
  });

  it("after_request plugin is a no-op when ctx has no response", async () => {
    const afterCache = new CachePlugin({ ttlSeconds: 60 }, "after_request");
    const ctx = createPluginContext(makeRequest());
    // No response set, no cache key in metadata

    const result = await afterCache.execute(ctx);
    expect(result.action).toBe("continue");
  });

  it("evicts oldest entry when cache exceeds maxSize", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60, maxSize: 2 }, "before_request");
    const afterCache = new CachePlugin({ ttlSeconds: 60, maxSize: 2 }, "after_request");

    // Store 3 entries
    for (let i = 0; i < 3; i++) {
      const ctx = createPluginContext(makeRequest({ model: `model-${String(i)}` }));
      await beforeCache.execute(ctx);
      ctx.response = makeResponse({ id: `resp-${String(i)}` });
      await afterCache.execute(ctx);
    }

    // The first entry should have been evicted
    const ctxFirst = createPluginContext(makeRequest({ model: "model-0" }));
    const result = await beforeCache.execute(ctxFirst);
    expect(result.action).toBe("continue");
  });

  it("cache key includes temperature", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const ctx1 = createPluginContext(makeRequest({ temperature: 0.7 }));
    const ctx2 = createPluginContext(makeRequest({ temperature: 1.0 }));

    await beforeCache.execute(ctx1);
    await beforeCache.execute(ctx2);

    expect(ctx1.metadata["_cacheKey"]).not.toBe(ctx2.metadata["_cacheKey"]);
  });

  it("different temperature for same messages produces cache miss", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const afterCache = new CachePlugin({ ttlSeconds: 60 }, "after_request");
    const response = makeResponse();

    const ctx1 = createPluginContext(makeRequest({ temperature: 0.5 }));
    await beforeCache.execute(ctx1);
    ctx1.response = response;
    await afterCache.execute(ctx1);

    const ctx2 = createPluginContext(makeRequest({ temperature: 0.9 }));
    const result = await beforeCache.execute(ctx2);
    expect(result.action).toBe("continue");
  });

  it("same all params produces cache hit", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const afterCache = new CachePlugin({ ttlSeconds: 60 }, "after_request");
    const response = makeResponse();

    const baseReq = makeRequest({ temperature: 0.7, seed: 42, maxTokens: 100 });
    const ctx1 = createPluginContext(baseReq);
    await beforeCache.execute(ctx1);
    ctx1.response = response;
    await afterCache.execute(ctx1);

    const ctx2 = createPluginContext(makeRequest({ temperature: 0.7, seed: 42, maxTokens: 100 }));
    const result = await beforeCache.execute(ctx2);
    expect(result.action).toBe("short_circuit");
  });

  it("cache key differs when tools are present vs absent", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const ctx1 = createPluginContext(makeRequest());
    const ctx2 = createPluginContext(makeRequest({
      tools: [{ type: "function", function: { name: "get_weather" } }],
    }));

    await beforeCache.execute(ctx1);
    await beforeCache.execute(ctx2);

    expect(ctx1.metadata["_cacheKey"]).not.toBe(ctx2.metadata["_cacheKey"]);
  });

  it("cache key differs when seed differs", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const ctx1 = createPluginContext(makeRequest({ seed: 1 }));
    const ctx2 = createPluginContext(makeRequest({ seed: 2 }));

    await beforeCache.execute(ctx1);
    await beforeCache.execute(ctx2);

    expect(ctx1.metadata["_cacheKey"]).not.toBe(ctx2.metadata["_cacheKey"]);
  });

  it("cache key differs when maxTokens differs", async () => {
    const beforeCache = new CachePlugin({ ttlSeconds: 60 }, "before_request");
    const ctx1 = createPluginContext(makeRequest({ maxTokens: 100 }));
    const ctx2 = createPluginContext(makeRequest({ maxTokens: 200 }));

    await beforeCache.execute(ctx1);
    await beforeCache.execute(ctx2);

    expect(ctx1.metadata["_cacheKey"]).not.toBe(ctx2.metadata["_cacheKey"]);
  });
});
