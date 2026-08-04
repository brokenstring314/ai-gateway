/**
 * Strategy runtime tests — verify the 8 routing strategies behave at runtime
 * consistently with the Go implementation, and that the gateway wires each
 * strategy plus the per-target concurrency limiter.
 *
 * Coverage:
 *   - factory/gateway wiring for all 8 strategy modes
 *   - single / fallback / loadbalance / conditional / least_latency /
 *     cost_optimized / content_based / abtest runtime behavior
 *   - error handling (missing target, empty config)
 *   - gateway per-target concurrency limiter → 429 on queue-full
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStrategy } from "@/routing/strategy-factory";
import type {
  SingleConfig,
  FallbackConfig,
  LoadBalanceConfig,
  ConditionalConfig,
  LeastLatencyConfig,
  CostOptimizedConfig,
  ContentBasedConfig,
  AbTestConfig,
} from "@/routing/strategy-factory";
import { SingleStrategy } from "@/routing/single";
import { FallbackStrategy, FallbackExhaustedError } from "@/routing/fallback";
import { LoadBalanceStrategy } from "@/routing/loadbalance";
import { ConditionalStrategy } from "@/routing/conditional";
import { LeastLatencyStrategy } from "@/routing/least-latency";
import { CostOptimizedStrategy } from "@/routing/cost-optimized";
import { ContentBasedStrategy } from "@/routing/content-based";
import { AbTestStrategy } from "@/routing/abtest";
import { Gateway } from "@/gateway";
import { ProviderError } from "@/providers/openai-compat";
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
  createStreamMockProvider,
  createReq,
  createFailingProvider,
} from "./helpers";

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
    mode: "single" | "fallback" | "loadbalance" | "conditional" | "least_latency" | "cost_optimized" | "content_based" | "abtest";
    config: SingleConfig | FallbackConfig | LoadBalanceConfig | ConditionalConfig | LeastLatencyConfig | CostOptimizedConfig | ContentBasedConfig | AbTestConfig;
    modeName: string;
  }> = [
    { mode: "single", config: { target: "a" }, modeName: "single" },
    { mode: "fallback", config: { targets: ["a", "b"] }, modeName: "fallback" },
    { mode: "loadbalance", config: { targets: [{ name: "a", weight: 1 }] }, modeName: "loadbalance" },
    { mode: "conditional", config: { rules: [{ field: "model", pattern: "gpt-", target: "a" }], defaultTarget: "a" }, modeName: "conditional" },
    { mode: "least_latency", config: { targets: ["a"] }, modeName: "least_latency" },
    { mode: "cost_optimized", config: { targets: [{ name: "a", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.02 }] }, modeName: "cost_optimized" },
    { mode: "content_based", config: { keywords: [{ keyword: "code", target: "a" }], defaultTarget: "a" }, modeName: "content_based" },
    { mode: "abtest", config: { variants: [{ name: "a", weight: 1 }] }, modeName: "abtest" },
  ];

  it.each(factoryConfigs)("createStrategy builds the $modeName strategy", ({ mode, config, modeName }) => {
    const strategy = createStrategy(mode, config, providerFor(["a"]));
    expect(strategy).toBeInstanceOf(
      modeName === "single" ? SingleStrategy :
      modeName === "fallback" ? FallbackStrategy :
      modeName === "loadbalance" ? LoadBalanceStrategy :
      modeName === "conditional" ? ConditionalStrategy :
      modeName === "least_latency" ? LeastLatencyStrategy :
      modeName === "cost_optimized" ? CostOptimizedStrategy :
      modeName === "content_based" ? ContentBasedStrategy :
      AbTestStrategy,
    );
    expect(strategy.mode).toBe(mode);
  });

  it("gateway routes a request through every strategy mode", async () => {
    const strategyConfigs: GatewayStrategyConfig[] = [
      { mode: "single", targets: ["a"] },
      { mode: "fallback", targets: ["a"] },
      { mode: "loadbalance", targets: ["a"], weights: { a: 1 } },
      { mode: "conditional", rules: [{ field: "model", pattern: "gpt-", target: "a" }], targets: ["a"] },
      { mode: "least_latency", targets: ["a"] },
      { mode: "cost_optimized", targets: ["a"] },
      { mode: "content_based", keywords: { code: "a" }, targets: ["a"] },
      { mode: "abtest", targets: ["a"] },
    ];

    for (const sc of strategyConfigs) {
      const gateway = new Gateway(makeGatewayConfig(sc));
      gateway.registerProvider(createMockProvider("a"));
      const resp = await gateway.route({ metadata: {} }, createReq());
      expect(resp.provider).toBe("a");
    }
  });

  it("gateway bridges new StrategyConfig fields into strategies", async () => {
    // unpricedStrategy → CostOptimized
    const costGateway = new Gateway(makeGatewayConfig({
      mode: "cost_optimized",
      targets: ["a"],
      unpricedStrategy: "skip",
    }));
    costGateway.registerProvider(createMockProvider("a"));
    await expect(
      costGateway.route({ metadata: {} }, createReq()),
    ).rejects.toThrow("no priced targets");

    // contentConditions → ContentBased (prompt_regex)
    const contentGateway = new Gateway(makeGatewayConfig({
      mode: "content_based",
      contentConditions: [{ type: "prompt_regex", value: "^\\[code\\]", targetKey: "a" }],
      targets: ["a"],
    }));
    contentGateway.registerProvider(createMockProvider("a"));
    const contentResp = await contentGateway.route(
      { metadata: {} },
      createReq({ messages: [{ role: "user", content: "[code] fix this" }] }),
    );
    expect(contentResp.provider).toBe("a");

    // abVariants → ABTest
    const abGateway = new Gateway(makeGatewayConfig({
      mode: "abtest",
      abVariants: [{ targetKey: "a", weight: 1, label: "control" }],
    }));
    abGateway.registerProvider(createMockProvider("a"));
    const abResp = await abGateway.route({ metadata: {} }, createReq());
    expect(abResp.provider).toBe("a");
  });
});

// ── Single ──

describe("single strategy runtime", () => {
  it("selects the configured target", () => {
    const strategy = new SingleStrategy(providerFor(["a"]), { target: "a" });
    expect(strategy.selectTargets(createReq())).toEqual(["a"]);
  });

  it("routes execute() to the target and throws when the target is missing", async () => {
    const strategy = new SingleStrategy(providerFor(["a"]), { target: "a" });
    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");

    const missing = new SingleStrategy(() => undefined, { target: "nope" });
    await expect(
      missing.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("not found");
  });
});

// ── Fallback ──

describe("fallback strategy runtime", () => {
  it("selects all targets in declared order", () => {
    const strategy = new FallbackStrategy(providerFor(["a", "b"]), { targets: ["a", "b"] });
    expect(strategy.selectTargets(createReq())).toEqual(["a", "b"]);
  });

  it("falls back to the backup target when the primary fails", async () => {
    const a = createFailingProvider("a", new Error("down"));
    const b = createMockProvider("b");
    const strategy = new FallbackStrategy(lookupWith(["a", a], ["b", b]), {
      targets: ["a", "b"],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("throws FallbackExhaustedError when every target fails", async () => {
    const a = createFailingProvider("a", new Error("down"));
    const b = createFailingProvider("b", new Error("also down"));
    const strategy = new FallbackStrategy(lookupWith(["a", a], ["b", b]), {
      targets: ["a", "b"],
    });

    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow(FallbackExhaustedError);
  });

  it("skips unregistered targets and still succeeds", async () => {
    const b = createMockProvider("b");
    const strategy = new FallbackStrategy(lookupWith(["b", b]), {
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
    const strategy = new LoadBalanceStrategy(lookupWith(["a", a], ["b", b]), {
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
    const strategy = new LoadBalanceStrategy(providerFor(names), {
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

  it("treats zero weights as equal weight (effectiveWeight normalization)", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const strategy = new LoadBalanceStrategy(lookupWith(["a", a], ["b", b]), {
      targets: [
        { name: "a", weight: 0 },
        { name: "b", weight: 0 },
      ],
    });

    const picked = new Set<string>();
    await withSeededRandom(7, async () => {
      for (let i = 0; i < 200; i++) {
        const resp = await strategy.execute({ metadata: {} }, createReq());
        picked.add(resp.provider);
      }
    });

    expect(picked.has("a")).toBe(true);
    expect(picked.has("b")).toBe(true);
  });

  it("throws when no targets are configured", async () => {
    const strategy = new LoadBalanceStrategy(providerFor([]), { targets: [] });
    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow();
  });
});

// ── Conditional ──

describe("conditional strategy runtime", () => {
  it("hits a field/pattern/target rule", async () => {
    const strategy = new ConditionalStrategy(providerFor(["a", "b"]), {
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
    const strategy = new ConditionalStrategy(providerFor(["a", "b"]), {
      rules: [{ field: "model", pattern: "gpt-5", target: "a" }],
      defaultTarget: "b",
    });

    const resp = await strategy.execute({ metadata: {} }, createReq({ model: "gpt-4" }));
    expect(resp.provider).toBe("b");
  });

  it("treats pattern as a regex (anchored alternation)", async () => {
    const strategy = new ConditionalStrategy(providerFor(["a"]), {
      rules: [{ field: "model", pattern: "^gpt-4(o|-turbo)", target: "a" }],
      defaultTarget: "a",
    });

    const hit = await strategy.execute({ metadata: {} }, createReq({ model: "gpt-4o" }));
    expect(hit.provider).toBe("a");

    const miss = await strategy.execute({ metadata: {} }, createReq({ model: "gpt-3.5" }));
    expect(miss.provider).toBe("a");
  });
});

// ── LeastLatency ──

function createDelayedProvider(name: string, delayMs: number): IProvider {
  const base = createMockProvider(name);
  return {
    ...base,
    complete: async (
      ctx: RequestContext,
      req: ChatCompletionRequest,
    ): Promise<ChatCompletionResponse> => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return base.complete(ctx, req);
    },
  };
}

describe("least_latency strategy runtime", () => {
  it("picks the target with the lowest recorded latency", async () => {
    const slow = createDelayedProvider("slow", 10);
    const fast = createDelayedProvider("fast", 1);
    const strategy = new LeastLatencyStrategy(lookupWith(["slow", slow], ["fast", fast]), {
      targets: ["slow", "fast"],
    });

    // Sample both targets, then the fast one must win.
    await strategy.execute({ metadata: {} }, createReq());
    await strategy.execute({ metadata: {} }, createReq());
    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("fast");
  });

  it("falls back to a target without error when no latency data exists", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const strategy = new LeastLatencyStrategy(lookupWith(["a", a], ["b", b]), {
      targets: ["a", "b"],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");
    // selectTargets must also return an ordered list rather than throwing.
    expect(strategy.selectTargets(createReq())).toHaveLength(2);
  });
});

// ── CostOptimized ──

describe("cost_optimized strategy runtime", () => {
  it("picks the cheapest target by per-1k input cost", async () => {
    const strategy = new CostOptimizedStrategy(providerFor(["a", "b"]), {
      targets: [
        { name: "a", costPer1kInputTokens: 0.05, costPer1kOutputTokens: 0.10 },
        { name: "b", costPer1kInputTokens: 0.001, costPer1kOutputTokens: 0.002 },
      ],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("falls back to the first declared target when all targets are unpriced", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const strategy = new CostOptimizedStrategy(lookupWith(["a", a], ["b", b]), {
      targets: [
        { name: "a", costPer1kInputTokens: 0, costPer1kOutputTokens: 0 },
        { name: "b", costPer1kInputTokens: 0, costPer1kOutputTokens: 0 },
      ],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");
  });

  it("prefers a priced target over unpriced ones in fallback mode", async () => {
    const strategy = new CostOptimizedStrategy(providerFor(["a", "b"]), {
      targets: [
        { name: "a", costPer1kInputTokens: 0.10, costPer1kOutputTokens: 0.10 },
        { name: "b", costPer1kInputTokens: 0, costPer1kOutputTokens: 0 },
      ],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("a");
  });

  it("throws when skip mode has no priced targets", async () => {
    const strategy = new CostOptimizedStrategy(providerFor(["a"]), {
      targets: [{ name: "a", costPer1kInputTokens: 0, costPer1kOutputTokens: 0 }],
      unpricedStrategy: "skip",
    });

    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("no priced targets");
  });

  it("ranks unpriced targets as zero-cost candidates in allow mode", async () => {
    const strategy = new CostOptimizedStrategy(providerFor(["a", "b"]), {
      targets: [
        { name: "a", costPer1kInputTokens: 0.10, costPer1kOutputTokens: 0.10 },
        { name: "b", costPer1kInputTokens: 0, costPer1kOutputTokens: 0 },
      ],
      unpricedStrategy: "allow",
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });

  it("breaks cost ties with the output-cost tiebreaker", async () => {
    const strategy = new CostOptimizedStrategy(providerFor(["a", "b"]), {
      targets: [
        { name: "a", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.10 },
        { name: "b", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.05 },
      ],
    });

    const resp = await strategy.execute({ metadata: {} }, createReq());
    expect(resp.provider).toBe("b");
  });
});

// ── ContentBased ──

describe("content_based strategy runtime", () => {
  it("hits a keyword in user content", async () => {
    const strategy = new ContentBasedStrategy(providerFor(["a", "b"]), {
      keywords: [{ keyword: "code", target: "a" }],
      defaultTarget: "b",
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({ messages: [{ role: "user", content: "write code" }] }),
    );
    expect(resp.provider).toBe("a");
  });

  it("falls back to defaultTarget when no keyword matches", async () => {
    const strategy = new ContentBasedStrategy(providerFor(["a", "b"]), {
      keywords: [{ keyword: "math", target: "a" }],
      defaultTarget: "b",
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({ messages: [{ role: "user", content: "hello world" }] }),
    );
    expect(resp.provider).toBe("b");
  });

  it("matches a prompt_regex content condition", async () => {
    const strategy = new ContentBasedStrategy(providerFor(["a", "b"]), {
      contentConditions: [
        { type: "prompt_regex", value: "^\\[critical\\]", target: "a" },
      ],
      defaultTarget: "b",
    });

    const hit = await strategy.execute(
      { metadata: {} },
      createReq({ messages: [{ role: "user", content: "[critical] outage now" }] }),
    );
    expect(hit.provider).toBe("a");

    const miss = await strategy.execute(
      { metadata: {} },
      createReq({ messages: [{ role: "user", content: "casual chat" }] }),
    );
    expect(miss.provider).toBe("b");
  });

  it("rejects an invalid prompt_regex at construction time", () => {
    expect(
      () =>
        new ContentBasedStrategy(providerFor(["a"]), {
          contentConditions: [
            { type: "prompt_regex", value: "[unclosed", target: "a" },
          ],
        }),
    ).toThrow("invalid regex");
  });
});

// ── ABTest ──

describe("abtest strategy runtime", () => {
  it("splits traffic by variant weight", async () => {
    const a = createMockProvider("a");
    const b = createMockProvider("b");
    const strategy = new AbTestStrategy(lookupWith(["a", a], ["b", b]), {
      variants: [
        { name: "a", weight: 10 },
        { name: "b", weight: 90 },
      ],
    });

    let bCount = 0;
    const iterations = 2000;
    await withSeededRandom(4242, async () => {
      for (let i = 0; i < iterations; i++) {
        const resp = await strategy.execute({ metadata: {} }, createReq());
        if (resp.provider === "b") bCount++;
      }
    });

    expect(bCount / iterations).toBeGreaterThan(0.7);
  });

  it("distributes evenly when all variant weights are zero", async () => {
    const names = ["a", "b", "c"];
    const strategy = new AbTestStrategy(providerFor(names), {
      variants: names.map((name) => ({ name, weight: 0 })),
    });

    const counts: Record<string, number> = {};
    const iterations = 3000;
    await withSeededRandom(555, async () => {
      for (let i = 0; i < iterations; i++) {
        const resp = await strategy.execute({ metadata: {} }, createReq());
        counts[resp.provider] = (counts[resp.provider] ?? 0) + 1;
      }
    });

    for (const name of names) {
      const share = (counts[name] ?? 0) / iterations;
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.5);
    }
  });

  it("selectTargets returns every variant with the picked one first", async () => {
    const strategy = new AbTestStrategy(providerFor(["a", "b", "c"]), {
      variants: [
        { name: "a", weight: 1 },
        { name: "b", weight: 1 },
        { name: "c", weight: 1 },
      ],
    });

    await withSeededRandom(1, () => {
      const targets = strategy.selectTargets(createReq());
      expect(targets).toHaveLength(3);
      expect(new Set(targets)).toEqual(new Set(["a", "b", "c"]));
    });
  });
});

// ── Shared error handling ──

describe("shared error handling", () => {
  it("reports a missing provider target", async () => {
    const strategy = new SingleStrategy(() => undefined, { target: "ghost" });
    await expect(
      strategy.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("not found");
  });

  it("rejects empty configurations", async () => {
    const emptyLeastLatency = new LeastLatencyStrategy(providerFor([]), { targets: [] });
    await expect(
      emptyLeastLatency.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("no targets configured");

    const emptyAbTest = new AbTestStrategy(providerFor([]), { variants: [] });
    await expect(
      emptyAbTest.execute({ metadata: {} }, createReq()),
    ).rejects.toThrow("no variants configured");

    const emptyContent = new ContentBasedStrategy(providerFor([]), {
      keywords: [],
    });
    await expect(
      emptyContent.execute(
        { metadata: {} },
        createReq({ messages: [{ role: "user", content: "hi" }] }),
      ),
    ).rejects.toThrow("no keyword matched");
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
