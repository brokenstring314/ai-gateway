/**
 * Zod schemas for configuration validation.
 * Schema = validation + type + documentation, single source of truth.
 */

import { z } from "zod";
import type { StrategyMode } from "../routing/types.js";

/** Go-style duration string: a positive integer followed by a unit (ms|s|m|h). */
function durationString(message: string): z.ZodString {
  return z.string().regex(/^\d+(ms|s|m|h)$/, message);
}

/** Strategy-mode YAML aliases — the Go config uses hyphenated forms. */
const STRATEGY_MODE_ALIASES: Record<string, StrategyMode> = {
  "least-latency": "least_latency",
  "cost-optimized": "cost_optimized",
  "content-based": "content_based",
  "ab-test": "abtest",
};

export const StrategyModeSchema = z.preprocess(
  (val) => (typeof val === "string" ? (STRATEGY_MODE_ALIASES[val] ?? val) : val),
  z.enum([
    "single",
    "fallback",
    "loadbalance",
    "conditional",
    "least_latency",
    "cost_optimized",
    "content_based",
    "abtest",
  ]),
);

export const StageSchema = z.enum(["before_request", "after_request", "on_error"]);

export const PluginTypeSchema = z.enum([
  "guardrail",
  "auth",
  "ratelimit",
  "transform",
  "logging",
  "metrics",
  "cache",
  "unknown",
]);

export const RetryConfigSchema = z.object({
  attempts: z.number().int().positive().optional().default(3),
  initialBackoffMs: z.number().positive().optional().default(100),
  onStatusCodes: z.array(z.number().int()).optional().default([408, 429, 500, 502, 503, 504]),
});

export const CircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().positive().optional().default(5),
  successThreshold: z.number().int().positive().optional().default(1),
  maxHalfThreshold: z.number().int().positive().optional().default(1),
  timeoutMs: z.number().positive().optional().default(30000),
});

export const ConcurrencyConfigSchema = z.object({
  maxConcurrency: z.number().int().positive().max(10000).optional(),
  queueSize: z.number().int().nonnegative().max(10000).optional().default(1000),
});

export const TargetConfigSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  apiKey: z.string().min(1),
  baseURL: z.string().url().optional(),
  models: z.array(z.string()).optional(),
  weight: z.number().positive().optional(),
  priority: z.number().int().nonnegative().optional(),
  budget: z.number().positive().optional(),
  costPer1kInputTokens: z.number().nonnegative().optional(),
  costPer1kOutputTokens: z.number().nonnegative().optional(),
  retry: RetryConfigSchema.optional(),
  circuitBreaker: CircuitBreakerConfigSchema.optional(),
  concurrency: ConcurrencyConfigSchema.optional(),
});

export const ConditionalRuleSchema = z.object({
  field: z.string().min(1),
  pattern: z.string().min(1),
  target: z.string().min(1),
});

/** Rename the Go `target_key` key to `targetKey` before validation. */
function normalizeTargetKey(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key === "target_key" ? "targetKey" : key] = value;
  }
  return out;
}

export const ConditionSchema = z.preprocess(
  normalizeTargetKey,
  z.object({
    key: z.string().min(1),
    value: z.string().min(1),
    targetKey: z.string().min(1),
  }),
);

export const ContentConditionSchema = z.preprocess(
  normalizeTargetKey,
  z.object({
    type: z.string().min(1),
    value: z.string().min(1),
    targetKey: z.string().min(1),
  }),
);

export const ABVariantSchema = z.preprocess(
  normalizeTargetKey,
  z.object({
    targetKey: z.string().min(1),
    weight: z.number().nonnegative().optional().default(1),
    label: z.string().min(1),
  }),
);

/** Rename Go snake_case strategy keys to camelCase before validation. */
function normalizeStrategyKeys(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[
      key === "unpriced_strategy" ? "unpricedStrategy" :
      key === "content_conditions" ? "contentConditions" :
      key === "ab_variants" ? "abVariants" :
      key
    ] = value;
  }
  return out;
}

export const StrategyConfigSchema = z.preprocess(
  normalizeStrategyKeys,
  z.object({
    mode: StrategyModeSchema,
    targets: z.array(z.string()).optional(),
    weights: z.record(z.string(), z.number()).optional(),
    rules: z.array(ConditionalRuleSchema).optional(),
    keywords: z.record(z.string(), z.string()).optional(),
    unpricedStrategy: z.enum(["fallback", "skip", "allow"]).optional().default("fallback"),
    conditions: z.array(ConditionSchema).optional(),
    contentConditions: z.array(ContentConditionSchema).optional(),
    abVariants: z.array(ABVariantSchema).optional(),
  }),
);

export const PluginConfigSchema = z.object({
  name: z.string().min(1),
  stage: StageSchema,
  type: PluginTypeSchema.optional().default("unknown"),
  enabled: z.boolean().optional().default(true),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ExporterConfigSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional().default(false),
  config: z.record(z.string(), z.unknown()).optional().default({}),
});

export const ObservabilityConfigSchema = z.object({
  tracing: z
    .object({
      enabled: z.boolean().optional().default(false),
      otlpEndpoint: z.string().optional(),
      otlpProtocol: z.enum(["grpc", "http"]).optional().default("http"),
      serviceName: z.string().optional().default("ai-gateway"),
      sampleRatio: z.number().min(0).max(1).optional().default(1.0),
      privacyLevel: z.enum(["none", "metadata", "full"]).optional().default("metadata"),
      shutdownGrace: durationString("Invalid shutdownGrace duration").optional().default("10s"),
      headers: z.record(z.string(), z.string()).optional().default({}),
    })
    .optional(),
  metrics: z
    .object({
      enabled: z.boolean().optional().default(false),
      port: z.number().int().positive().optional().default(9090),
    })
    .optional(),
  exporters: z.array(ExporterConfigSchema).optional(),
});

export const CompatibilityConfigSchema = z.object({
  onUnsupportedParam: z.enum(["warn", "drop", "reject"]).optional().default("warn"),
});

export const McpServerConfigSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["stdio", "http"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    maxCallDepth: z.number().int().positive().optional().default(5),
    timeoutSeconds: z.number().int().positive().optional().default(30),
    required: z.boolean().optional().default(false),
  })
  .superRefine((val, ctx) => {
    if (!val.command && !val.url) {
      ctx.addIssue({
        code: "custom",
        message: "mcp server requires either a command (stdio) or a url (http)",
      });
    }
  });

export const GatewayConfigSchema = z.object({
  apiVersion: z.string().optional().default("v1"),
  strategy: StrategyConfigSchema,
  targets: z.array(TargetConfigSchema).min(1),
  maxRequestBytes: z.number().int().positive().optional().default(10 * 1024 * 1024),
  requestTimeout: durationString("Invalid requestTimeout duration").optional(),
  plugins: z.array(PluginConfigSchema).optional(),
  aliases: z.record(z.string(), z.string()).optional(),
  mcpServers: z.array(McpServerConfigSchema).optional(),
  observability: ObservabilityConfigSchema.optional(),
  compatibility: CompatibilityConfigSchema.optional(),
  server: z
    .object({
      port: z.number().int().positive().optional().default(3000),
      host: z.string().optional().default("0.0.0.0"),
      // Bun.serve idleTimeout (seconds, 0 = never, Bun max 255). Must exceed
      // the longest silent gap of a slow non-streaming upstream call.
      idleTimeoutSeconds: z.number().int().min(0).max(255).optional(),
      // SSE `: ping` heartbeat interval while a stream is idle (0 = off).
      sseHeartbeatSeconds: z.number().min(0).optional(),
      // Upstream idle timeout for SSE streams once the response started
      // (seconds, 0 = off, default 120) and optional max stream duration.
      streamIdleTimeoutSeconds: z.number().min(0).optional(),
      streamMaxDurationSeconds: z.number().min(0).optional(),
    })
    .optional(),
  // Opt-in pass-through proxy for other /v1/* routes (see config/types.ts).
  passthroughProxy: z.object({ enabled: z.boolean().optional() }).optional(),
  adminSecret: z.string().min(8).optional(),
  auth: z
    .object({
      // No default: client auth is disabled ONLY when enabled === false is set
      // explicitly. Omitting it (e.g. `auth: { keys: [...] }`) keeps auth on;
      // see isClientAuthEnabled().
      enabled: z.boolean().optional(),
      keys: z.array(z.string()).optional(),
    })
    .optional(),
  cors: z
    .object({
      enabled: z.boolean().optional().default(false),
      origins: z.array(z.string()).optional(),
      // Unset/empty = reflect the preflight's Access-Control-Request-Headers.
      allowHeaders: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Parse and validate a GatewayConfig from unknown input. Throws ZodError on failure. */
export function parseConfig(input: unknown) {
  return GatewayConfigSchema.parse(input);
}

/** Safely parse — returns result object instead of throwing. */
export function safeParseConfig(input: unknown) {
  return GatewayConfigSchema.safeParse(input);
}
