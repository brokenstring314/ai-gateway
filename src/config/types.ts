/**
 * Configuration types — derived from Zod schema in schema.ts.
 */

import type { StrategyMode } from "../routing/types.js";
import type { Stage } from "../plugins/types.js";

export interface RetryConfig {
  attempts?: number;
  initialBackoffMs?: number;
  onStatusCodes?: number[];
}

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  successThreshold?: number;
  timeoutMs?: number;
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
}

export interface ConditionalRule {
  field: string;
  pattern: string;
  target: string;
}

export interface PluginConfig {
  name: string;
  stage: Stage;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface ObservabilityConfig {
  tracing?: {
    enabled?: boolean;
    otlpEndpoint?: string;
    otlpProtocol?: "grpc" | "http";
    serviceName?: string;
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
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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
