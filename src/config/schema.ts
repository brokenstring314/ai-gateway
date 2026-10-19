/**
 * Zod schemas for configuration validation.
 * Schema = validation + type + documentation, single source of truth.
 */

import { PASSTHROUGH_ROUTE_PATTERN } from "../core/surfaces/passthrough.js";
import { z } from "zod";
import type { StrategyMode } from "../routing/types.js";
import { DURATION_HINT, parseDuration } from "./duration.js";
import { strictObject, unknownKeysMessage } from "./strict.js";
import { configReferenceIssues } from "./validate.js";
import {
  DEPRECATED_STRATEGY_MODES,
  REMOVED_OBSERVABILITY_KEYS,
  REMOVED_STRATEGY_KEYS,
  REMOVED_STRATEGY_MODES,
  REMOVED_TARGET_KEYS,
  OTLP_GRPC_UNSUPPORTED,
  canonicalStrategyMode,
} from "./removed.js";

/** Duration string validated by the shared parser (config/duration.ts). */
function durationString(field: string) {
  return z.string().refine((v) => parseDuration(v) !== undefined, {
    message: `Invalid ${field} duration; ${DURATION_HINT}`,
  });
}

export { unknownKeysMessage };

const STRATEGY_MODES = ["single", "fallback", "loadbalance", "conditional"] as const satisfies readonly StrategyMode[];

/**
 * Strategy mode. Removed modes (least_latency, cost_optimized, content_based)
 * fail with a migration hint; the deprecated abtest alias maps to loadbalance
 * (configDeprecationWarnings reports it).
 */
export const StrategyModeSchema = z
  .string()
  .superRefine((val, ctx) => {
    const mode = canonicalStrategyMode(val);
    const hint = REMOVED_STRATEGY_MODES[mode];
    if (hint !== undefined) {
      ctx.addIssue({ code: "custom", message: hint });
    } else if (DEPRECATED_STRATEGY_MODES[mode] === undefined && !(STRATEGY_MODES as readonly string[]).includes(mode)) {
      ctx.addIssue({
        code: "custom",
        message: `unknown strategy mode "${val}"; expected one of ${STRATEGY_MODES.join(", ")}`,
      });
    }
  })
  .transform((val): StrategyMode => {
    const mode = canonicalStrategyMode(val);
    return DEPRECATED_STRATEGY_MODES[mode] ?? (mode as StrategyMode);
  });

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

export const RetryConfigSchema = strictObject({
  attempts: z.number().int().positive().optional().default(3),
  initialBackoffMs: z.number().positive().optional().default(100),
  onStatusCodes: z.array(z.number().int()).optional().default([408, 429, 500, 502, 503, 504]),
});

export const CircuitBreakerConfigSchema = strictObject({
  failureThreshold: z.number().int().positive().optional().default(5),
  successThreshold: z.number().int().positive().optional().default(1),
  maxHalfThreshold: z.number().int().positive().optional().default(1),
  timeoutMs: z.number().positive().optional().default(30000),
});

export const ConcurrencyConfigSchema = strictObject({
  maxConcurrency: z.number().int().positive().max(10000).optional(),
  queueSize: z.number().int().nonnegative().max(10000).optional().default(1000),
});

export const TargetConfigSchema = strictObject(
  {
    name: z.string().min(1),
    provider: z.string().min(1),
    apiKey: z.string().min(1),
    // A URL, or a string with ${VAR} refs (validated as a URL after expansion,
    // when the provider is built).
    baseURL: z
      .string()
      .refine((v) => /\$\{[^}]+\}/.test(v) || URL.canParse(v), { message: "Invalid URL" })
      .optional(),
    models: z.array(z.string()).optional(),
    weight: z.number().nonnegative().optional(),
    costPer1kInputTokens: z.number().nonnegative().optional(),
    costPer1kOutputTokens: z.number().nonnegative().optional(),
    retry: RetryConfigSchema.optional(),
    circuitBreaker: CircuitBreakerConfigSchema.optional(),
    concurrency: ConcurrencyConfigSchema.optional(),
  },
  REMOVED_TARGET_KEYS,
);

export const ConditionalRuleSchema = strictObject({
  field: z.enum(["model", "user", "message", "prompt"]),
  pattern: z.string().min(1).optional(),
  contains: z.string().min(1).optional(),
  target: z.string().min(1),
}).superRefine((rule, ctx) => {
  if ((rule.pattern === undefined) === (rule.contains === undefined)) {
    ctx.addIssue({ code: "custom", message: 'a rule needs exactly one of "pattern" (regex) or "contains"' });
  }
  if (rule.pattern !== undefined) {
    try {
      new RegExp(rule.pattern);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
});

export const StrategyConfigSchema = strictObject(
  {
    mode: StrategyModeSchema,
    targets: z.array(z.string()).optional(),
    weights: z.record(z.string(), z.number().nonnegative()).optional(),
    rules: z.array(ConditionalRuleSchema).optional(),
  },
  REMOVED_STRATEGY_KEYS,
);

export const PluginConfigSchema = strictObject({
  name: z.string().min(1),
  stage: StageSchema,
  type: PluginTypeSchema.optional().default("unknown"),
  enabled: z.boolean().optional().default(true),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ObservabilityConfigSchema = strictObject(
  {
    tracing: strictObject({
      enabled: z.boolean().optional().default(false),
      otlpEndpoint: z.string().optional(),
      // Only OTLP/HTTP is implemented; grpc fails with a migration hint.
      otlpProtocol: z
        .string()
        .superRefine((val, ctx) => {
          if (val === "grpc") ctx.addIssue({ code: "custom", message: OTLP_GRPC_UNSUPPORTED });
          else if (val !== "http")
            ctx.addIssue({ code: "custom", message: `unknown otlpProtocol "${val}"; expected http` });
        })
        .transform(() => "http" as const)
        .optional()
        .default("http"),
      serviceName: z.string().optional().default("ai-gateway"),
      sampleRatio: z.number().min(0).max(1).optional().default(1.0),
      privacyLevel: z.enum(["none", "metadata", "full"]).optional().default("metadata"),
      shutdownGrace: durationString("shutdownGrace").optional().default("10s"),
      headers: z.record(z.string(), z.string()).optional().default({}),
    }).optional(),
    metrics: strictObject({
      enabled: z.boolean().optional().default(false),
      port: z.number().int().positive().optional(),
    }).optional(),
  },
  REMOVED_OBSERVABILITY_KEYS,
);

export const CompatibilityConfigSchema = strictObject({
  onUnsupportedParam: z.enum(["warn", "drop", "reject"]).optional().default("warn"),
});

const MCP_HTTP_REMOVED =
  "MCP http transport is not supported (removed in 0.2.0; it was never implemented): use a stdio server (command/args)";

export const McpServerConfigSchema = strictObject({
  name: z.string().min(1),
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritEnv: z.union([z.boolean(), z.array(z.string())]).optional(),
  url: z.unknown().optional(),
  headers: z.unknown().optional(),
  allowedTools: z.array(z.string()).optional(),
  // No default here: the loop uses the smallest value any server sets (5 when none does).
  maxCallDepth: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional().default(30),
  required: z.boolean().optional().default(false),
})
  .superRefine((val, ctx) => {
    if (val.type === "http" || val.url !== undefined || val.headers !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [val.type === "http" ? "type" : val.url !== undefined ? "url" : "headers"],
        message: MCP_HTTP_REMOVED,
      });
    } else if (val.type !== undefined && val.type !== "stdio") {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: `unknown MCP transport "${val.type}"; only stdio is supported`,
      });
    }
    if (!val.command) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "mcp server requires a command (stdio)" });
    }
  })
  .transform(({ url: _url, headers: _headers, type: _type, ...rest }) => ({ ...rest, type: "stdio" as const }));

export const GatewayConfigSchema = strictObject({
  apiVersion: z.string().optional().default("v1"),
  strategy: StrategyConfigSchema,
  targets: z.array(TargetConfigSchema).min(1),
  maxRequestBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10 * 1024 * 1024),
  requestTimeout: durationString("requestTimeout").optional(),
  plugins: z.array(PluginConfigSchema).optional(),
  aliases: z.record(z.string(), z.string()).optional(),
  mcpServers: z.array(McpServerConfigSchema).optional(),
  observability: ObservabilityConfigSchema.optional(),
  compatibility: CompatibilityConfigSchema.optional(),
  server: strictObject({
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
    // Per-client-IP token bucket on /v1/* (off unless rps > 0).
    perIpRateLimit: strictObject({ rps: z.number().min(0).optional(), burst: z.number().min(0).optional() }).optional(),
  }).optional(),
  // Opt-in pass-through proxy for other /v1/* routes (see config/types.ts).
  passthroughProxy: strictObject({
    enabled: z.boolean().optional(),
    routes: z
      .array(z.string().regex(PASSTHROUGH_ROUTE_PATTERN, 'expected "METHOD /v1/path" or "METHOD /v1/prefix/*"'))
      .optional(),
  }).optional(),
  adminSecret: z.string().min(8).optional(),
  auth: strictObject({
    // No default: client auth is disabled ONLY when enabled === false is set
    // explicitly. Omitting it (e.g. `auth: { keys: [...] }`) keeps auth on;
    // see isClientAuthEnabled().
    enabled: z.boolean().optional(),
    keys: z.array(z.string()).optional(),
  }).optional(),
  cors: strictObject({
    enabled: z.boolean().optional().default(false),
    origins: z.array(z.string()).optional(),
    // Unset/empty = reflect the preflight's Access-Control-Request-Headers.
    allowHeaders: z.array(z.string()).optional(),
  }).optional(),
}).superRefine((cfg, ctx) => {
  // Cross-references (target names, strategy targets/weights/rules, baseURL):
  // shared with the embedded Gateway constructor.
  for (const issue of configReferenceIssues(cfg)) ctx.addIssue({ code: "custom", ...issue });
});

/** Parse and validate a GatewayConfig from unknown input. Throws ZodError on failure. */
export function parseConfig(input: unknown) {
  return GatewayConfigSchema.parse(input);
}

/** Safely parse — returns result object instead of throwing. */
export function safeParseConfig(input: unknown) {
  return GatewayConfigSchema.safeParse(input);
}
