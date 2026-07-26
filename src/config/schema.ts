/**
 * Zod schemas for configuration validation.
 * Schema = validation + type + documentation, single source of truth.
 */

import { z } from "zod";

export const StrategyModeSchema = z.enum([
  "single",
  "fallback",
  "loadbalance",
  "conditional",
  "least_latency",
  "cost_optimized",
  "content_based",
  "abtest",
]);

export const StageSchema = z.enum(["before_request", "after_request", "on_error"]);

export const RetryConfigSchema = z.object({
  attempts: z.number().int().positive().optional().default(3),
  initialBackoffMs: z.number().positive().optional().default(100),
  onStatusCodes: z.array(z.number().int()).optional().default([408, 429, 500, 502, 503, 504]),
});

export const CircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().positive().optional().default(5),
  successThreshold: z.number().int().positive().optional().default(1),
  timeoutMs: z.number().positive().optional().default(30000),
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
});

export const ConditionalRuleSchema = z.object({
  field: z.string().min(1),
  pattern: z.string().min(1),
  target: z.string().min(1),
});

export const StrategyConfigSchema = z.object({
  mode: StrategyModeSchema,
  targets: z.array(z.string()).optional(),
  weights: z.record(z.string(), z.number()).optional(),
  rules: z.array(ConditionalRuleSchema).optional(),
  keywords: z.record(z.string(), z.string()).optional(),
});

export const PluginConfigSchema = z.object({
  name: z.string().min(1),
  stage: StageSchema,
  enabled: z.boolean().optional().default(true),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ObservabilityConfigSchema = z.object({
  tracing: z
    .object({
      enabled: z.boolean().optional().default(false),
      otlpEndpoint: z.string().optional(),
      otlpProtocol: z.enum(["grpc", "http"]).optional().default("http"),
      serviceName: z.string().optional().default("ai-gateway"),
    })
    .optional(),
  metrics: z
    .object({
      enabled: z.boolean().optional().default(false),
      port: z.number().int().positive().optional().default(9090),
    })
    .optional(),
});

export const CompatibilityConfigSchema = z.object({
  onUnsupportedParam: z.enum(["warn", "drop", "reject"]).optional().default("warn"),
});

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const GatewayConfigSchema = z.object({
  apiVersion: z.string().optional(),
  strategy: StrategyConfigSchema,
  targets: z.array(TargetConfigSchema).min(1),
  maxRequestBytes: z.number().int().positive().optional().default(10 * 1024 * 1024),
  requestTimeout: z.string().optional(),
  plugins: z.array(PluginConfigSchema).optional(),
  aliases: z.record(z.string(), z.string()).optional(),
  mcpServers: z.array(McpServerConfigSchema).optional(),
  observability: ObservabilityConfigSchema.optional(),
  compatibility: CompatibilityConfigSchema.optional(),
  server: z
    .object({
      port: z.number().int().positive().optional().default(3000),
      host: z.string().optional().default("0.0.0.0"),
    })
    .optional(),
  adminSecret: z.string().min(8).optional(),
  auth: z
    .object({
      enabled: z.boolean().optional().default(false),
      keys: z.array(z.string()).optional(),
    })
    .optional(),
  cors: z
    .object({
      enabled: z.boolean().optional().default(false),
      origins: z.array(z.string()).optional(),
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
