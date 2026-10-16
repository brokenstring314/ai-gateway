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

/** Conditional rule (Go Condition): key/value match routed to a target. */
export interface Condition {
  key: string;
  value: string;
  targetKey: string;
}

/** Content-based rule (Go ContentCondition). */
export interface ContentCondition {
  type: string;
  value: string;
  targetKey: string;
}

/** Weighted ab-test variant (Go ABVariantConfig). */
export interface ABVariant {
  targetKey: string;
  weight: number;
  label: string;
}

export interface StrategyConfig {
  mode: StrategyMode;
  /** Fallback: ordered target names. LoadBalance: target→weight. ABTest: variant→weight. */
  targets?: string[];
  weights?: Record<string, number>;
  /** Conditional: field→pattern→target rules. */
  rules?: ConditionalRule[];
  /** ContentBased: keyword→target mapping. */
  keywords?: Record<string, string>;
  /** CostOptimized: how unpriced targets are handled. */
  unpricedStrategy?: "fallback" | "skip" | "allow";
  /** Conditional: key→value→target rules (Go conditions). */
  conditions?: Condition[];
  /** ContentBased: ordered content-match rules (Go content_conditions). */
  contentConditions?: ContentCondition[];
  /** ABTest: weighted variants (Go ab_variants). */
  abVariants?: ABVariant[];
}

export interface ConditionalRule {
  field: string;
  pattern: string;
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
  };
  adminSecret?: string;
  auth?: {
    enabled?: boolean;
    keys?: string[];
  };
  cors?: {
    enabled?: boolean;
    origins?: string[];
  };
}
