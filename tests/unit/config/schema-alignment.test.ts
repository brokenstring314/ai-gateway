import { describe, expect, it } from "bun:test";
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

function parseErrors(input: Record<string, unknown>): string {
  const r = safeParseConfig(input);
  expect(r.success).toBe(false);
  return r.success ? "" : r.error.issues.map((x) => x.message).join("\n");
}

describe("strategy modes and fields (0.2.0)", () => {
  for (const [mode, hint] of [
    ["least_latency", "use fallback"],
    ["least-latency", "use fallback"],
    ["cost_optimized", "cheapest to most expensive"],
    ["cost-optimized", "cheapest to most expensive"],
    ["content_based", "field: prompt"],
    ["content-based", "field: prompt"],
  ] as const) {
    it(`removed mode ${mode} fails with a migration hint`, () => {
      const msg = parseErrors(baseConfig({ strategy: { mode, targets: ["primary"] } }));
      expect(msg).toContain("removed in 0.2.0");
      expect(msg).toContain(hint);
    });
  }

  it("abtest / ab-test is a deprecated alias of loadbalance", () => {
    expect(parseConfig(baseConfig({ strategy: { mode: "abtest", targets: ["primary"] } })).strategy.mode).toBe("loadbalance");
    expect(parseConfig(baseConfig({ strategy: { mode: "ab-test", targets: ["primary"] } })).strategy.mode).toBe("loadbalance");
  });

  it("rejects an unknown strategy mode", () => {
    expect(parseErrors(baseConfig({ strategy: { mode: "magic" } }))).toContain('unknown strategy mode "magic"');
  });

  for (const key of ["conditions", "content_conditions", "contentConditions", "keywords", "ab_variants", "abVariants", "unpriced_strategy", "unpricedStrategy"]) {
    it(`removed strategy key ${key} fails with a migration hint`, () => {
      const msg = parseErrors(baseConfig({ strategy: { mode: "fallback", targets: ["primary"], [key]: [] } }));
      expect(msg).toContain(`strategy.${key}`);
      expect(msg).toContain("was removed in 0.2.0");
    });
  }

  it("conditional rules: field prompt + contains or pattern; exactly one; regex validated", () => {
    const ok = parseConfig(baseConfig({
      strategy: { mode: "conditional", targets: ["primary"], rules: [
        { field: "prompt", contains: "code", target: "primary" },
        { field: "model", pattern: "^gpt-", target: "primary" },
      ] },
    }));
    expect(ok.strategy.rules?.length).toBe(2);
    expect(parseErrors(baseConfig({ strategy: { mode: "conditional", rules: [{ field: "prompt", target: "primary" }] } })))
      .toContain("exactly one");
    expect(parseErrors(baseConfig({ strategy: { mode: "conditional", rules: [{ field: "prompt", pattern: "x", contains: "y", target: "primary" }] } })))
      .toContain("exactly one");
    expect(parseErrors(baseConfig({ strategy: { mode: "conditional", rules: [{ field: "model", pattern: "[bad", target: "primary" }] } })))
      .toContain("invalid regex");
  });

  it("loadbalance weights: negative rejected, 0 allowed, all-0 rejected (C3-9)", () => {
    expectParseFailure(baseConfig({ strategy: { mode: "loadbalance", weights: { primary: -1 } } }));
    expect(parseErrors(baseConfig({ strategy: { mode: "loadbalance", weights: { primary: 0 } } }))).toContain("every target has weight 0");
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
