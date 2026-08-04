import { describe, expect, it } from "vitest";
import { parseConfig, safeParseConfig } from "../../../src/config/schema.js";

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strategy: { mode: "fallback", targets: ["primary"] },
    targets: [{ name: "primary", provider: "openai", apiKey: "sk-test" }],
    ...overrides,
  };
}

function expectParseFailure(input: Record<string, unknown>): void {
  const result = safeParseConfig(input);
  expect(result.success).toBe(false);
}

describe("config defaults", () => {
  it("defaults apiVersion to v1", () => {
    const config = parseConfig(baseConfig());
    expect(config.apiVersion).toBe("v1");
  });

  it("defaults maxRequestBytes to 10485760", () => {
    const config = parseConfig(baseConfig());
    expect(config.maxRequestBytes).toBe(10485760);
  });

  it("keeps requestTimeout undefined when omitted", () => {
    const config = parseConfig(baseConfig());
    expect(config.requestTimeout).toBeUndefined();
  });

  it("defaults compatibility.onUnsupportedParam to warn", () => {
    const config = parseConfig(baseConfig({ compatibility: {} }));
    expect(config.compatibility?.onUnsupportedParam).toBe("warn");
  });

  it("parses aliases and adminSecret", () => {
    const config = parseConfig(
      baseConfig({ aliases: { fast: "gpt-4o" }, adminSecret: "a-very-long-admin-secret" }),
    );
    expect(config.aliases).toEqual({ fast: "gpt-4o" });
    expect(config.adminSecret).toBe("a-very-long-admin-secret");
  });
});

describe("duration validation", () => {
  it("accepts a valid requestTimeout duration", () => {
    expect(safeParseConfig(baseConfig({ requestTimeout: "30s" })).success).toBe(true);
  });

  it("rejects a non-duration requestTimeout", () => {
    expectParseFailure(baseConfig({ requestTimeout: "abc" }));
    expectParseFailure(baseConfig({ requestTimeout: "30" }));
  });

  it("accepts a valid shutdownGrace and rejects an invalid one", () => {
    expect(
      safeParseConfig(baseConfig({ observability: { tracing: { shutdownGrace: "500ms" } } })).success,
    ).toBe(true);
    expectParseFailure(baseConfig({ observability: { tracing: { shutdownGrace: "later" } } }));
  });
});

describe("target concurrency", () => {
  it("parses maxConcurrency and queueSize", () => {
    const config = parseConfig(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            concurrency: { maxConcurrency: 50, queueSize: 250 },
          },
        ],
      }),
    );
    expect(config.targets[0]!.concurrency).toEqual({ maxConcurrency: 50, queueSize: 250 });
  });

  it("defaults queueSize to 1000 when omitted", () => {
    const config = parseConfig(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            concurrency: { maxConcurrency: 10 },
          },
        ],
      }),
    );
    expect(config.targets[0]!.concurrency).toEqual({ maxConcurrency: 10, queueSize: 1000 });
  });

  it("rejects maxConcurrency above 10000", () => {
    expectParseFailure(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            concurrency: { maxConcurrency: 10001 },
          },
        ],
      }),
    );
  });

  it("rejects non-positive maxConcurrency", () => {
    expectParseFailure(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            concurrency: { maxConcurrency: 0 },
          },
        ],
      }),
    );
  });

  it("rejects a negative queueSize", () => {
    expectParseFailure(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            concurrency: { maxConcurrency: 5, queueSize: -1 },
          },
        ],
      }),
    );
  });

  it("rejects queueSize above 10000", () => {
    expectParseFailure(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            concurrency: { maxConcurrency: 5, queueSize: 10001 },
          },
        ],
      }),
    );
  });
});

describe("circuit breaker", () => {
  it("parses maxHalfThreshold alongside existing fields", () => {
    const config = parseConfig(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            circuitBreaker: { failureThreshold: 3, successThreshold: 2, maxHalfThreshold: 4, timeoutMs: 5000 },
          },
        ],
      }),
    );
    expect(config.targets[0]!.circuitBreaker).toEqual({
      failureThreshold: 3,
      successThreshold: 2,
      maxHalfThreshold: 4,
      timeoutMs: 5000,
    });
  });

  it("defaults maxHalfThreshold to 1", () => {
    const config = parseConfig(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            circuitBreaker: { failureThreshold: 5 },
          },
        ],
      }),
    );
    expect(config.targets[0]!.circuitBreaker?.maxHalfThreshold).toBe(1);
  });

  it("rejects a non-positive maxHalfThreshold", () => {
    expectParseFailure(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-test",
            circuitBreaker: { maxHalfThreshold: 0 },
          },
        ],
      }),
    );
  });
});

describe("plugin config", () => {
  it("parses a plugin type and defaults it to unknown", () => {
    const withType = parseConfig(
      baseConfig({
        plugins: [{ name: "word-filter", stage: "before_request", type: "guardrail" }],
      }),
    );
    expect(withType.plugins?.[0]!.type).toBe("guardrail");

    const withoutType = parseConfig(
      baseConfig({ plugins: [{ name: "word-filter", stage: "before_request" }] }),
    );
    expect(withoutType.plugins?.[0]!.type).toBe("unknown");
  });

  it("rejects an unknown plugin type", () => {
    expectParseFailure(
      baseConfig({ plugins: [{ name: "x", stage: "before_request", type: "not-a-type" }] }),
    );
  });
});

describe("observability", () => {
  it("parses exporters with name, enabled and config", () => {
    const config = parseConfig(
      baseConfig({
        observability: {
          exporters: [{ name: "langsmith", enabled: true, config: { api_key: "k" } }],
        },
      }),
    );
    expect(config.observability?.exporters?.[0]).toEqual({
      name: "langsmith",
      enabled: true,
      config: { api_key: "k" },
    });
  });

  it("defaults exporter enabled to false and config to {}", () => {
    const config = parseConfig(
      baseConfig({ observability: { exporters: [{ name: "langsmith" }] } }),
    );
    expect(config.observability?.exporters?.[0]?.enabled).toBe(false);
    expect(config.observability?.exporters?.[0]?.config).toEqual({});
  });

  it("rejects an exporter without a name", () => {
    expectParseFailure(
      baseConfig({ observability: { exporters: [{ enabled: true }] } }),
    );
  });

  it("defaults sampleRatio to 1.0 and privacyLevel to metadata", () => {
    const config = parseConfig(baseConfig({ observability: { tracing: { enabled: true } } }));
    expect(config.observability?.tracing?.sampleRatio).toBe(1.0);
    expect(config.observability?.tracing?.privacyLevel).toBe("metadata");
    expect(config.observability?.tracing?.shutdownGrace).toBe("10s");
  });

  it("parses explicit sampleRatio, privacyLevel and headers", () => {
    const config = parseConfig(
      baseConfig({
        observability: {
          tracing: {
            sampleRatio: 0.25,
            privacyLevel: "none",
            headers: { "x-api-key": "k" },
          },
        },
      }),
    );
    expect(config.observability?.tracing).toMatchObject({
      sampleRatio: 0.25,
      privacyLevel: "none",
      headers: { "x-api-key": "k" },
    });
  });

  it("rejects sampleRatio above 1 or below 0", () => {
    expectParseFailure(baseConfig({ observability: { tracing: { sampleRatio: 1.5 } } }));
    expectParseFailure(baseConfig({ observability: { tracing: { sampleRatio: -0.1 } } }));
  });

  it("rejects an invalid privacyLevel", () => {
    expectParseFailure(baseConfig({ observability: { tracing: { privacyLevel: "verbose" } } }));
  });
});

describe("strategy aliases and fields", () => {
  it("maps least-latency and least_latency to least_latency", () => {
    const hyphen = parseConfig(baseConfig({ strategy: { mode: "least-latency", targets: ["primary"] } }));
    const underscore = parseConfig(baseConfig({ strategy: { mode: "least_latency", targets: ["primary"] } }));
    expect(hyphen.strategy.mode).toBe("least_latency");
    expect(underscore.strategy.mode).toBe("least_latency");
  });

  it("maps cost-optimized to cost_optimized", () => {
    const config = parseConfig(baseConfig({ strategy: { mode: "cost-optimized", targets: ["primary"] } }));
    expect(config.strategy.mode).toBe("cost_optimized");
  });

  it("maps content-based to content_based", () => {
    const config = parseConfig(baseConfig({ strategy: { mode: "content-based", targets: ["primary"] } }));
    expect(config.strategy.mode).toBe("content_based");
  });

  it("maps ab-test to abtest", () => {
    const config = parseConfig(baseConfig({ strategy: { mode: "ab-test", targets: ["primary"] } }));
    expect(config.strategy.mode).toBe("abtest");
  });

  it("rejects an unknown strategy mode", () => {
    expectParseFailure(baseConfig({ strategy: { mode: "magic" } }));
  });

  it("accepts snake_case strategy keys and target_key", () => {
    const config = parseConfig(
      baseConfig({
        strategy: {
          mode: "content-based",
          unpriced_strategy: "skip",
          conditions: [{ key: "country", value: "US", target_key: "primary" }],
          content_conditions: [{ type: "prompt_contains", value: "code", target_key: "primary" }],
          ab_variants: [{ target_key: "primary", weight: 2, label: "control" }],
        },
      }),
    );
    const strategy = config.strategy;
    expect(strategy.mode).toBe("content_based");
    expect(strategy.unpricedStrategy).toBe("skip");
    expect(strategy.conditions?.[0]).toEqual({ key: "country", value: "US", targetKey: "primary" });
    expect(strategy.contentConditions?.[0]).toEqual({
      type: "prompt_contains",
      value: "code",
      targetKey: "primary",
    });
    expect(strategy.abVariants?.[0]).toEqual({ targetKey: "primary", weight: 2, label: "control" });
  });

  it("accepts camelCase strategy fields and defaults unpricedStrategy to fallback", () => {
    const config = parseConfig(
      baseConfig({
        strategy: {
          mode: "cost_optimized",
          targets: ["primary"],
          unpricedStrategy: "allow",
          contentConditions: [{ type: "prompt_regex", value: "^hi", targetKey: "primary" }],
        },
      }),
    );
    expect(config.strategy.unpricedStrategy).toBe("allow");
    expect(config.strategy.contentConditions?.[0]?.targetKey).toBe("primary");

    const fallback = parseConfig(baseConfig({ strategy: { mode: "fallback", targets: ["primary"] } }));
    expect(fallback.strategy.unpricedStrategy).toBe("fallback");
  });
});

describe("mcp servers", () => {
  it("parses allowedTools, maxCallDepth, timeoutSeconds and required", () => {
    const config = parseConfig(
      baseConfig({
        mcpServers: [
          { name: "fs", command: "npx", allowedTools: ["read"], maxCallDepth: 3, timeoutSeconds: 60, required: true },
        ],
      }),
    );
    expect(config.mcpServers?.[0]).toMatchObject({
      allowedTools: ["read"],
      maxCallDepth: 3,
      timeoutSeconds: 60,
      required: true,
    });
  });

  it("defaults maxCallDepth to 5, timeoutSeconds to 30 and required to false", () => {
    const config = parseConfig(baseConfig({ mcpServers: [{ name: "fs", command: "npx" }] }));
    expect(config.mcpServers?.[0]).toMatchObject({
      maxCallDepth: 5,
      timeoutSeconds: 30,
      required: false,
    });
  });

  it("infers transport from command when type is omitted", () => {
    const config = parseConfig(baseConfig({ mcpServers: [{ name: "fs", command: "npx" }] }));
    expect(config.mcpServers?.[0]?.command).toBe("npx");
    expect(config.mcpServers?.[0]?.type).toBeUndefined();
  });

  it("rejects an mcp server with neither command nor url", () => {
    expectParseFailure(baseConfig({ mcpServers: [{ name: "fs" }] }));
  });
});

describe("backward compatibility", () => {
  it("parses a legacy config without any new fields", () => {
    const result = safeParseConfig({
      apiVersion: "v1",
      strategy: { mode: "single", targets: ["primary"] },
      targets: [{ name: "primary", provider: "openai", apiKey: "sk-1" }],
      maxRequestBytes: 10485760,
      plugins: [{ name: "word-filter", stage: "before_request" }],
      aliases: { fast: "gpt-4o" },
      observability: { tracing: { enabled: true, otlpEndpoint: "localhost:4317" } },
      compatibility: { onUnsupportedParam: "warn" },
      mcpServers: [{ name: "fs", type: "stdio", command: "npx" }],
      server: { port: 3000 },
      adminSecret: "a-very-long-admin-secret",
    });
    expect(result.success).toBe(true);
  });

  it("retains the retry config fields", () => {
    const config = parseConfig(
      baseConfig({
        targets: [
          {
            name: "primary",
            provider: "openai",
            apiKey: "sk-1",
            retry: { attempts: 5, initialBackoffMs: 250, onStatusCodes: [429, 503] },
          },
        ],
      }),
    );
    expect(config.targets[0]!.retry).toEqual({
      attempts: 5,
      initialBackoffMs: 250,
      onStatusCodes: [429, 503],
    });
  });
});
