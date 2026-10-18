/**
 * Configuration types — derived from Zod schema in schema.ts.
 */

import type { StrategyMode } from "../routing/types.js";
import type { Stage } from "../plugins/types.js";

/** Plugin type categories, mirroring the Go plugin.PluginType values. */
export type PluginType =
  | "guardrail"
  | "auth"
  | "ratelimit"
  | "transform"
  | "logging"
  | "metrics"
  | "cache"
  | "unknown";

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
  priority?: number;
  budget?: number;
  costPer1kInputTokens?: number;
  costPer1kOutputTokens?: number;
  retry?: RetryConfig;
  circuitBreaker?: CircuitBreakerConfig;
  concurrency?: ConcurrencyConfig;
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

export interface ExporterConfig {
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface ObservabilityConfig {
  tracing?: {
    enabled?: boolean;
    otlpEndpoint?: string;
    otlpProtocol?: "grpc" | "http";
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
  exporters?: ExporterConfig[];
}

export interface CompatibilityConfig {
  onUnsupportedParam: "warn" | "drop" | "reject";
}

export interface McpServerConfig {
  name: string;
  /** Transport; inferred from command/url when omitted. */
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Gateway environment passed to the stdio subprocess. Default: only a small
   * allowlist (PATH, HOME, LANG, TMPDIR, ...). A list adds those variable
   * names; `true` passes the whole environment (secrets included).
   */
  inheritEnv?: boolean | string[];
  url?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
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
  };
  /**
   * Pass-through proxy for /v1/* routes without a dedicated handler
   * (e.g. /v1/responses). Off by default: proxied requests skip circuit
   * breakers, fallback, after-request plugins and budget accrual. When on,
   * before-request plugins still run.
   */
  passthroughProxy?: {
    enabled?: boolean;
  };
  adminSecret?: string;
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
