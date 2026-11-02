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

const TargetKeyObjectSchema = strictObject({
  // Stable id (set by the config store; optional in the file).
  id: z.string().min(1).max(100).optional(),
  key: z.string(),
  weight: z.number().nonnegative().optional(),
  enabled: z.boolean().optional(),
});

/**
 * One upstream key of a target: the key itself, or { key, weight, enabled }
 * (0.3.0 P4). Checked by hand rather than with z.union so a mistake in the
 * object form reports the offending field instead of "Invalid input".
 */
export const TargetKeySchema = z
  .unknown()
  .superRefine((v, ctx) => {
    if (typeof v === "string") return;
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      ctx.addIssue({ code: "custom", message: "a key is a string or an object { key, weight?, enabled? }" });
      return;
    }
    const r = TargetKeyObjectSchema.safeParse(v);
    if (!r.success)
      for (const issue of r.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  })
  .transform((v) => v as string | z.infer<typeof TargetKeyObjectSchema>);

export const KEY_STRATEGIES = ["round_robin", "weighted", "fill_first"] as const;
export const BALANCE_MODES = ["weighted", "round_robin", "least_inflight"] as const;

export const TargetConfigSchema = strictObject(
  {
    name: z.string().min(1),
    provider: z.string().min(1),
    // One key (apiKey) or several (apiKeys); at least one of the two (see superRefine).
    apiKey: z.string().min(1).optional(),
    apiKeys: z.array(TargetKeySchema).max(1000).optional(),
    keyStrategy: z.enum(KEY_STRATEGIES).optional(),
    keyCooldownSeconds: z.number().int().positive().max(3600).optional(),
    enabled: z.boolean().optional(),
    // Refuse non-public upstream addresses at request time (set for channels written via the Admin API).
    publicNetworkOnly: z.boolean().optional(),
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
).superRefine((t, ctx) => {
  if (t.apiKey === undefined && t.apiKeys === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["apiKey"],
      message: 'target needs an upstream key: "apiKey" (one key) or "apiKeys" (several)',
    });
  }
});

export const ModelMetadataSchema = strictObject({
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  inputModalities: z.array(z.enum(["text", "image", "audio", "video", "pdf"])).optional(),
  tools: z.boolean().optional(),
  parallelTools: z.boolean().optional(),
  structuredOutput: z.enum(["none", "json_object", "json_schema"]).optional(),
  reasoning: z
    .union([
      z.boolean(),
      strictObject({
        efforts: z.array(z.string().min(1)).min(1).optional(),
        map: z.record(z.string().min(1), z.record(z.string(), z.unknown())).optional(),
      }),
    ])
    .optional(),
  webSearch: z.boolean().optional(),
  logprobs: z.boolean().optional(),
  systemMessage: z.enum(["supported", "merge_into_user"]).optional(),
  developerRole: z.enum(["as_system", "passthrough"]).optional(),
});

export const PublishedModelSchema = strictObject({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  displayName: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  strategy: z.enum(["fallback", "loadbalance"]).optional(),
  // How to pick within a priority group (0.3.0 P4).
  balance: z.enum(BALANCE_MODES).optional(),
  // Empty (or every binding disabled / on a disabled target): published but unavailable (503).
  bindings: z.array(
    strictObject({
      target: z.string().min(1),
      model: z.string().min(1).optional(),
      priority: z.number().int().optional(),
      weight: z.number().nonnegative().optional(),
      enabled: z.boolean().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  metadata: ModelMetadataSchema.optional(),
});

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
  models: z.array(PublishedModelSchema).optional(),
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
  // Where targets/strategy/aliases/plugins/compatibility come from (0.3.0):
  // "database" (default; imported from this file on first start, then
  // managed live) or "file" (this file only, read-only, as in 0.2.0).
  runtimeConfig: strictObject({ source: z.enum(["database", "file"]).optional() }).optional(),
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
