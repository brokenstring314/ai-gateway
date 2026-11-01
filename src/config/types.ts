/**
 * Configuration types — derived from Zod schema in schema.ts.
 */

import type { StrategyMode } from "../routing/types.js";
import type { Stage } from "../plugins/types.js";

/** Plugin type categories, mirroring the Go plugin.PluginType values. */
export type PluginType = "guardrail" | "auth" | "ratelimit" | "transform" | "logging" | "metrics" | "cache" | "unknown";

export interface RetryConfig {
  attempts?: number;
  initialBackoffMs?: number;
  onStatusCodes?: number[];
}

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  successThreshold?: number;
  maxHalfThreshold?: number;
  timeoutMs?: number;
}

export interface ConcurrencyConfig {
  maxConcurrency?: number;
  queueSize?: number;
}

export interface TargetConfig {
  name: string;
  provider: string;
  apiKey: string;
  baseURL?: string;
  models?: string[];
  weight?: number;
  costPer1kInputTokens?: number;
  costPer1kOutputTokens?: number;
  retry?: RetryConfig;
  circuitBreaker?: CircuitBreakerConfig;
  concurrency?: ConcurrencyConfig;
}

/** How a model handles reasoning_effort (0.3.0 P3). */
export interface ReasoningConfig {
  /** Accepted reasoning_effort values; any other value is rejected. Unset: any value. */
  efforts?: string[];
  /** reasoning_effort value → upstream parameters sent instead of it (e.g. none → {thinking: {type: disabled}}). */
  map?: Record<string, Record<string, unknown>>;
}

/**
 * Capabilities and limits of a published model (0.3.0, plan §3.4). Shown on
 * /v1/models and enforced before a request leaves the gateway (P3): a
 * request the model cannot serve is rejected with 400 and the reason.
 * Unset fields fall back to what is known about the bound upstream models
 * (core/model-presets.ts); unknown stays unchecked.
 */
export interface ModelMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Array<"text" | "image" | "audio" | "video" | "pdf">;
  tools?: boolean;
  parallelTools?: boolean;
  structuredOutput?: "none" | "json_object" | "json_schema";
  /** false: reasoning_effort rejected; true: passed through; object: allowed efforts / mapping. */
  reasoning?: boolean | ReasoningConfig;
  webSearch?: boolean;
  logprobs?: boolean;
  /** "supported" (default) or "merge_into_user": system messages are prepended to the first user message. */
  systemMessage?: "supported" | "merge_into_user";
  /** "as_system" (default): developer messages are sent as system; "passthrough": unchanged. */
  developerRole?: "as_system" | "passthrough";
}

/** One channel serving a published model. */
export interface ModelBindingConfig {
  /** Target (channel) name. */
  target: string;
  /** Model name sent upstream; default: the published name. */
  model?: string;
  /** fallback: lower first (default: list order). */
  priority?: number;
  /** loadbalance: relative share (0 = drained). Default 1. */
  weight?: number;
  /** Extra upstream body fields for this binding (win over the request's and the reasoning map's). */
  params?: Record<string, unknown>;
}

/**
 * A model name this gateway serves (0.3.0). Requests for it go only to its
 * bindings, with the upstream model name rewritten per binding.
 */
export interface PublishedModelConfig {
  name: string;
  enabled?: boolean;
  displayName?: string;
  description?: string;
  /** How to pick among the bindings. Default fallback. */
  strategy?: "fallback" | "loadbalance";
  bindings: ModelBindingConfig[];
  metadata?: ModelMetadata;
}

export interface StrategyConfig {
  mode: StrategyMode;
  /** single: [target]. fallback: ordered targets. loadbalance: the pool. conditional: [defaultTarget]. */
  targets?: string[];
  /** loadbalance: target → weight (0 = drained, never selected). */
  weights?: Record<string, number>;
  /** conditional: first matching rule wins. */
  rules?: ConditionalRule[];
}

export interface ConditionalRule {
  field: "model" | "user" | "message" | "prompt";
  /** Regex tested against the field. */
  pattern?: string;
  /** Case-insensitive substring. Exactly one of pattern/contains. */
  contains?: string;
  target: string;
}

export interface PluginConfig {
  name: string;
  stage: Stage;
  type?: PluginType;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface ObservabilityConfig {
  tracing?: {
    enabled?: boolean;
    otlpEndpoint?: string;
    /** Only "http" (OTLP/HTTP) is supported; "grpc" fails validation. */
    otlpProtocol?: "http";
    serviceName?: string;
    sampleRatio?: number;
    privacyLevel?: "none" | "metadata" | "full";
    shutdownGrace?: string;
    headers?: Record<string, string>;
  };
  metrics?: {
    enabled?: boolean;
    port?: number;
  };
}

export interface CompatibilityConfig {
  onUnsupportedParam: "warn" | "drop" | "reject";
}

export interface McpServerConfig {
  name: string;
  /** Transport: stdio only. */
  type?: "stdio";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Gateway environment passed to the stdio subprocess. Default: only a small
   * allowlist (PATH, HOME, LANG, TMPDIR, ...). A list adds those variable
   * names; `true` passes the whole environment (secrets included).
   */
  inheritEnv?: boolean | string[];
  allowedTools?: string[];
  /** Agentic-loop depth limit; the loop uses the smallest value any server sets (default 5). */
  maxCallDepth?: number;
  timeoutSeconds?: number;
  required?: boolean;
}

export interface GatewayConfig {
  apiVersion?: string;
  strategy: StrategyConfig;
  targets: TargetConfig[];
  maxRequestBytes?: number;
  requestTimeout?: string;
  plugins?: PluginConfig[];
  aliases?: Record<string, string>;
  /**
   * Published models (0.3.0). Only these names (and aliases of them) are
   * served; anything else is rejected with 404 model_not_found. When unset,
   * every name in targets[].models is published, routed by `strategy` over
   * the targets that list it.
   */
  models?: PublishedModelConfig[];
  mcpServers?: McpServerConfig[];
  observability?: ObservabilityConfig;
  compatibility?: CompatibilityConfig;
  server?: {
    port?: number;
    host?: string;
    /** Bun.serve idleTimeout in seconds (0 = disabled, max 255). Default 255. */
    idleTimeoutSeconds?: number;
    /** SSE `: ping` heartbeat interval while a stream is idle (0 = off). Default 5. */
    sseHeartbeatSeconds?: number;
    /**
     * Abort a streaming response when the upstream sends nothing for this
     * many seconds after the SSE response started (0 = off). Default 120.
     */
    streamIdleTimeoutSeconds?: number;
    /** Hard cap on a streaming response's total duration in seconds (0 = off). Default 0. */
    streamMaxDurationSeconds?: number;
    /**
     * Per-client-IP token bucket on /v1/*. Off unless rps > 0. burst defaults
     * to 2 × rps. RATE_LIMIT_RPS / RATE_LIMIT_BURST override these.
     */
    perIpRateLimit?: { rps?: number; burst?: number };
  };
  /**
   * Pass-through proxy for /v1/* routes without a dedicated handler
   * (e.g. /v1/responses). Off by default: proxied requests skip circuit
   * breakers, fallback, after-request plugins and budget accrual. When on,
   * before-request plugins still run.
   */
  passthroughProxy?: {
    enabled?: boolean;
    /**
     * Method+path allow-list of forwarded routes ("POST /v1/responses",
     * "POST /v1/audio/*"). Default: POST /v1/responses, /v1/moderations,
     * /v1/audio/*. Anything else gets 403 route_not_allowed.
     */
    routes?: string[];
  };
  adminSecret?: string;
  /**
   * Where the runtime sections (targets, strategy, aliases, plugins,
   * compatibility) come from. "database" (default): imported from this file
   * on first start into <dataDir>/config.sqlite, then managed live; the
   * file's runtime sections are ignored afterwards. "file": this file only,
   * read-only (0.2.0 behaviour, for GitOps).
   */
  runtimeConfig?: { source?: "database" | "file" };
  auth?: {
    enabled?: boolean;
    keys?: string[];
  };
  cors?: {
    enabled?: boolean;
    origins?: string[];
    /** Access-Control-Allow-Headers. Unset/empty = reflect Access-Control-Request-Headers. */
    allowHeaders?: string[];
  };
}
