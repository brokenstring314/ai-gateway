/**
 * Strategy runtime tests — verify the 8 routing strategies behave at runtime
 * consistently with the Go implementation, and that the gateway wires each
 * strategy plus the per-target concurrency limiter.
 *
 * Coverage:
 *   - factory/gateway wiring for all 8 strategy modes
 *   - single / fallback / loadbalance / conditional runtime behavior
 *   - error handling (missing target, empty config)
 *   - gateway per-target concurrency limiter → 429 on queue-full
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { createStrategy } from "@/routing/strategy-factory";
import type {
  SingleConfig,
  FallbackConfig,
  LoadBalanceConfig,
  ConditionalConfig,
} from "@/routing/strategy-factory";
import { SingleStrategy } from "@/routing/single";
import { FallbackStrategy, FallbackExhaustedError } from "@/routing/fallback";
import { LoadBalanceStrategy } from "@/routing/loadbalance";
import { ConditionalStrategy } from "@/routing/conditional";
import { Gateway } from "@/gateway";
import type {
  ChatCompletionResponse,
  ChatCompletionRequest,
  RequestContext,
  IProvider,
  StreamChunk,
} from "@/providers/types";
import type { GatewayConfig, StrategyConfig as GatewayStrategyConfig } from "@/config/types";
import {
  createMockProvider,
  createReq,
  createFailingProvider,
} from "./helpers";
import { boundConditional, boundFallback, boundLoadBalance, boundSingle } from "./helpers";

// ── Test helpers ──

/** Deterministic PRNG so distribution assertions are stable across runs. */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function withSeededRandom(
  seed: number,
  fn: () => Promise<void> | void,
): Promise<void> {
  const spy = vi.spyOn(Math, "random").mockImplementation(seededRandom(seed));
  return (async () => {
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
  })();
}

function providerFor(names: string[]): (name: string) => IProvider | undefined {
  const providers = new Map(names.map((n) => [n, createMockProvider(n)]));
  return (name: string) => providers.get(name);
}

function lookupWith(...pairs: Array<[string, IProvider]>): (name: string) => IProvider | undefined {
  const map = new Map(pairs);
  return (name: string) => map.get(name);
}

function makeGatewayConfig(strategy: GatewayStrategyConfig): GatewayConfig {
  return {
    strategy,
    targets: [
      {
        name: "a",
        provider: "openai",
        apiKey: "sk-test",
        baseURL: "http://localhost:1234/v1",
      },
    ],
  };
}

function makeResponse(provider = "a"): ChatCompletionResponse {
  return {
    id: "resp-1",
    object: "chat.completion",
    created: Date.now(),
    model: "gpt-4",
    provider,
    choices: [
      { index: 0, message: { role: "assistant", content: "hi" }, finishReason: "stop" },
    ],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
  };
}

// ── Factory + gateway wiring (task 1) ──

describe("strategy factory & gateway wiring", () => {
  const factoryConfigs: Array<{
    mode: "single" | "fallback" | "loadbalance" | "conditional";
    config: SingleConfig | FallbackConfig | LoadBalanceConfig | ConditionalConfig;
    modeName: string;
  }> = [
    { mode: "single", config: { target: "a" }, modeName: "single" },
    { mode: "fallback", config: { targets: ["a", "b"] }, modeName: "fallback" },
    { mode: "loadbalance", config: { targets: [{ name: "a", weight: 1 }] }, modeName: "loadbalance" },
    { mode: "conditional", config: { rules: [{ field: "model", pattern: "gpt-", target: "a" }], defaultTarget: "a" }, modeName: "conditional" },
  ];

  it.each(factoryConfigs)("createStrategy builds the $modeName strategy", ({ mode, config, modeName }) => {
    const strategy = createStrategy(mode, config);
    expect(strategy).toBeInstanceOf(
      modeName === "single" ? SingleStrategy :
      modeName === "fallback" ? FallbackStrategy :
      modeName === "loadbalance" ? LoadBalanceStrategy :
      ConditionalStrategy,
    );
    expect(strategy.mode).toBe(mode);
  });

  it("gateway routes a request through every strategy mode", async () => {
    const strategyConfigs: GatewayStrategyConfig[] = [
      { mode: "single", targets: ["a"] },
      { mode: "fallback", targets: ["a"] },
      { mode: "loadbalance", targets: ["a"], weights: { a: 1 } },
      { mode: "conditional", rules: [{ field: "model", pattern: "gpt-", target: "a" }], targets: ["a"] },
      { mode: "conditional", rules: [{ field: "prompt", contains: "code", target: "a" }], targets: ["a"] },
    ];

    for (const sc of strategyConfigs) {
      const gateway = new Gateway(makeGatewayConfig(sc));
      gateway.registerProvider(createMockProvider("a"));
      const resp = await gateway.route({ metadata: {} }, createReq());
      expect(resp.provider).toBe("a");
    }
  });

});

// ── Single ──

describe("single strategy runtime", () => {
  it("selects the configured target", () => {
    const strategy = boundSingle(providerFor(["a"]), { target: "a" });
    expect(strategy.selectTargets(createReq())).toEqual(["a"]);
  });

  it("routes execute() to the target and throws when the target is missing", async () => {
    const strategy = boundSingle(providerFor(["a"]), { target: "a" });
    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");

    const missing = boundSingle(() => undefined, { target: "nope" });
    await expect(
      missing.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("not found");
  });
});

// ── Fallback ──

describe("fallback strategy runtime", () => {
  it("selects all targets in declared order", () => {
    const strategy = boundFallback(providerFor(["a", "b"]), { targets: ["a", "b"] });
    expect(strategy.selectTargets(createReq())).toEqual(["a", "b"]);
  });

  it("falls back to the backup target when the primary fails", async () => {
    const a = createFailingProvider("a", new Error("down"));
    const b = createMockProvider("b");
    const strategy = boundFallback(lookupWith(["a", a], ["b", b]), {
      targets: ["a", "b"],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("throws FallbackExhaustedError when every target fails", async () => {
    const a = createFailingProvider("a", new Error("down"));
    const b = createFailingProvider("b", new Error("also down"));
    const strategy = boundFallback(lookupWith(["a", a], ["b", b]), {
      targets: ["a", "b"],
    });

    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow(FallbackExhaustedError);
  });

  it("skips unregistered targets and still succeeds", async () => {
    const b = createMockProvider("b");
    const strategy = boundFallback(lookupWith(["b", b]), {
      targets: ["missing", "b"],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });
});

// ── LoadBalance ──

describe("loadbalance strategy runtime", () => {
  it("distributes calls by weight (heavy target gets the majority)", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const strategy = boundLoadBalance(lookupWith(["a", a], ["b", b]), {
      targets: [
        { name: "a", weight: 20 },
        { name: "b", weight: 80 },
      ],
    });

    let bCount = 0;
    const iterations = 2000;
    await withSeededRandom(12345, async () => {
      for (let i = 0; i < iterations; i++) {
        const resp = await strategy.execute({ metadata: {} }, createReq());
        if (resp.provider === "b") bCount++;
      }
    });

    // b carries 80% of the weight; a seeded run must stay well above 60%.
    expect(bCount / iterations).toBeGreaterThan(0.6);
  });

  it("distributes evenly when all weights are equal", async () => {
    const names = ["a", "b", "c", "d"];
    const strategy = boundLoadBalance(providerFor(names), {
      targets: names.map((name) => ({ name, weight: 1 })),
    });

    const counts: Record<string, number> = {};
    const iterations = 4000;
    await withSeededRandom(999, async () => {
      for (let i = 0; i < iterations; i++) {
        const resp = await strategy.execute({ metadata: {} }, createReq());
        counts[resp.provider] = (counts[resp.provider] ?? 0) + 1;
      }
    });

    for (const name of names) {
      const share = (counts[name] ?? 0) / iterations;
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.35);
    }
  });

  it("weight 0 drains a target: never selected, not even as failover (C3-9)", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const strategy = boundLoadBalance(lookupWith(["a", a], ["b", b]), {
      targets: [
        { name: "a", weight: 0 },
        { name: "b", weight: 1 },
      ],
    });
    for (let i = 0; i < 50; i++) {
      expect(strategy.selectTargets(createReq())).toEqual(["b"]);
      const resp = await strategy.execute({ metadata: {} }, createReq());
      expect(resp.provider).toBe("b");
    }
  });

  it("throws at construction when every weight is 0 or no targets are configured", () => {
    expect(() => boundLoadBalance(providerFor(["a"]), { targets: [{ name: "a", weight: 0 }] })).toThrow(/weight 0/);
    expect(() => boundLoadBalance(providerFor([]), { targets: [] })).toThrow();
  });
});

// ── Conditional ──

describe("conditional strategy runtime", () => {
  it("hits a field/pattern/target rule", async () => {
    const strategy = boundConditional(providerFor(["a", "b"]), {
      rules: [
        { field: "model", pattern: "gpt-", target: "a" },
        { field: "model", pattern: "llama", target: "b" },
      ],
      defaultTarget: "b",
    });

    const resp = await strategy.execute({ metadata: {} }, createReq({ model: "gpt-4" }));
    expect(resp.provider).toBe("a");
  });

  it("falls back to defaultTarget when no rule matches", async () => {
    const strategy = boundConditional(providerFor(["a", "b"]), {
      rules: [{ field: "model", pattern: "gpt-5", target: "a" }],
      defaultTarget: "b",
    });

    const resp = await strategy.execute({ metadata: {} }, createReq({ model: "gpt-4" }));
    expect(resp.provider).toBe("b");
  });

  it("treats pattern as a regex (anchored alternation)", async () => {
    const strategy = boundConditional(providerFor(["a"]), {
      rules: [{ field: "model", pattern: "^gpt-4(o|-turbo)", target: "a" }],
      defaultTarget: "a",
    });

    const hit = await strategy.execute({ metadata: {} }, createReq({ model: "gpt-4o" }));
    expect(hit.provider).toBe("a");

    const miss = await strategy.execute({ metadata: {} }, createReq({ model: "gpt-3.5" }));
    expect(miss.provider).toBe("a");
  });
});

describe("shared error handling", () => {
  it("reports a missing provider target", async () => {
    const strategy = boundSingle(() => undefined, { target: "ghost" });
    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("not found");
  });

  it("embedded Gateway: removed modes throw the migration hint, abtest runs as loadbalance", async () => {
    expect(() => new Gateway(makeGatewayConfig({ mode: "least_latency" as never, targets: ["a"] }))).toThrow(/removed in 0.2.0/);
    const g = new Gateway(makeGatewayConfig({ mode: "abtest" as never, targets: ["a"] }));
    g.registerProvider(createMockProvider("a"));
    expect((await g.route({ metadata: {} }, createReq())).provider).toBe("a");
  });

});

// ── Gateway per-target concurrency limiter (task 4) ──

describe("gateway per-target concurrency limiter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function limitedGatewayConfig(maxConcurrency: number, queueSize: number) {
    return {
      strategy: { mode: "single", targets: ["limited"] },
      targets: [
        {
          name: "limited",
          provider: "openai",
          apiKey: "sk-test",
          baseURL: "http://localhost:1234/v1",
          concurrency: { maxConcurrency, queueSize },
        },
      ],
    } satisfies GatewayConfig;
  }

  it("rejects a second request with HTTP 429 when the queue is full", async () => {
    const gateway = new Gateway(limitedGatewayConfig(1, 0));

    let resolveFirst: (r: ChatCompletionResponse) => void = () => {};
    const gate = new Promise<ChatCompletionResponse>((resolve) => {
      resolveFirst = resolve;
    });
    gateway.registerProvider({
      name: "limited",
      complete: () => gate,
      supportedModels: () => [],
      supportsModel: () => true,
      models: () => [],
    });

    const first = gateway.route({ metadata: {} }, createReq());
    // Let the first request acquire its slot.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = gateway.route({ metadata: {} }, createReq());
    await expect(second).rejects.toMatchObject({ statusCode: 429 });

    resolveFirst(makeResponse("limited"));
    const firstResp = await first;
    expect(firstResp.provider).toBe("limited");

    const limiter = gateway.getConcurrencyLimiterRegistry().get("limited");
    expect(limiter?.inFlight).toBe(0);
  });

  it("acquires before executing and releases after completion", async () => {
    const gateway = new Gateway(limitedGatewayConfig(1, 1));

    let resolveFirst: (r: ChatCompletionResponse) => void = () => {};
    const gate = new Promise<ChatCompletionResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const complete = vi.fn().mockReturnValue(gate);
    gateway.registerProvider({
      name: "limited",
      complete,
      supportedModels: () => [],
      supportsModel: () => true,
      models: () => [],
    });

    const pending = gateway.route({ metadata: {} }, createReq());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const limiter = gateway.getConcurrencyLimiterRegistry().get("limited");
    expect(limiter?.inFlight).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);

    resolveFirst(makeResponse());
    await pending;
    expect(limiter?.inFlight).toBe(0);
  });

  it("holds the slot for the whole stream and releases when it finishes", async () => {
    const gateway = new Gateway(limitedGatewayConfig(1, 1));
    const streamProvider: IProvider & {
      completeStream(ctx: RequestContext, req: ChatCompletionRequest): AsyncIterable<StreamChunk>;
    } = {
      name: "limited",
      complete: async () => makeResponse(),
      completeStream: async function* (): AsyncIterable<StreamChunk> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield {
          id: "chunk-1",
          object: "chat.completion.chunk",
          created: Date.now(),
          model: "gpt-4",
          choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finishReason: "stop" }],
        };
      },
      supportedModels: () => [],
      supportsModel: () => true,
      models: () => [],
    };
    gateway.registerProvider(streamProvider);

    const limiter = gateway.getConcurrencyLimiterRegistry().get("limited");
    const iterator = gateway.routeStream({ metadata: {} }, createReq())[Symbol.asyncIterator]();
    const first = iterator.next();
    const firstResult = await first;
    expect(firstResult.done).toBe(false);
    expect(limiter?.inFlight).toBe(1);

    await iterator.next();
    expect(limiter?.inFlight).toBe(0);
  });

  it("routes without a limiter when no concurrency is configured", async () => {
    const gateway = new Gateway(makeGatewayConfig({ mode: "single", targets: ["a"] }));
    const complete = vi.fn().mockResolvedValue(makeResponse("a"));
    gateway.registerProvider({
      name: "a",
      complete,
      supportedModels: () => [],
      supportsModel: () => true,
      models: () => [],
    });

    const resp = await gateway.route({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");
    expect(gateway.getConcurrencyLimiterRegistry().get("a")).toBeUndefined();
  });
});
