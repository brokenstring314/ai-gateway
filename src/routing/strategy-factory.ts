/**
 * Strategy factory — creates routing strategies from config + provider lookup.
 * Also re-exports all strategy config types for convenience.
 */

import type { ProviderLookup, IStrategy, StrategyMode } from "./types.js";
import { SingleStrategy } from "./single.js";
import { FallbackStrategy } from "./fallback.js";
import { LoadBalanceStrategy } from "./loadbalance.js";
import { ConditionalStrategy } from "./conditional.js";
import { LeastLatencyStrategy } from "./least-latency.js";
import { CostOptimizedStrategy } from "./cost-optimized.js";
import { ContentBasedStrategy } from "./content-based.js";
import { AbTestStrategy } from "./abtest.js";
import type { RetryConfig } from "../config/types.js";

// ── Strategy config types ──

export interface SingleConfig {
  readonly target: string;
}

export interface FallbackConfig {
  readonly targets: readonly string[];
  readonly retryConfigs?: ReadonlyMap<string, RetryConfig>;
}

export interface LoadBalanceTarget {
  readonly name: string;
  readonly weight: number;
}

export interface LoadBalanceConfig {
  readonly targets: readonly LoadBalanceTarget[];
}

export interface ConditionalRule {
  readonly field: string;
  readonly pattern: string;
  readonly target: string;
}

export interface ConditionalConfig {
  readonly rules: readonly ConditionalRule[];
  readonly defaultTarget?: string;
}

export interface LeastLatencyConfig {
  readonly targets: readonly string[];
  readonly windowSize?: number;
}

export interface CostOptimizedTarget {
  readonly name: string;
  readonly costPer1kInputTokens: number;
  readonly costPer1kOutputTokens: number;
}

export interface CostOptimizedConfig {
  readonly targets: readonly CostOptimizedTarget[];
}

export interface ContentBasedMapping {
  readonly keyword: string;
  readonly target: string;
}

export interface ContentBasedConfig {
  readonly keywords: readonly ContentBasedMapping[];
  readonly defaultTarget?: string;
}

export interface AbTestVariant {
  readonly name: string;
  readonly weight: number;
}

export interface AbTestConfig {
  readonly variants: readonly AbTestVariant[];
}

export type StrategyConfig =
  | SingleConfig
  | FallbackConfig
  | LoadBalanceConfig
  | ConditionalConfig
  | LeastLatencyConfig
  | CostOptimizedConfig
  | ContentBasedConfig
  | AbTestConfig;

/**
 * Create a routing strategy from its mode, typed config, and provider lookup.
 */
export function createStrategy(
  mode: StrategyMode,
  config: StrategyConfig,
  lookup: ProviderLookup,
): IStrategy {
  switch (mode) {
    case "single":
      return new SingleStrategy(lookup, config as SingleConfig);
    case "fallback":
      return new FallbackStrategy(lookup, config as FallbackConfig);
    case "loadbalance":
      return new LoadBalanceStrategy(lookup, config as LoadBalanceConfig);
    case "conditional":
      return new ConditionalStrategy(lookup, config as ConditionalConfig);
    case "least_latency":
      return new LeastLatencyStrategy(lookup, config as LeastLatencyConfig);
    case "cost_optimized":
      return new CostOptimizedStrategy(lookup, config as CostOptimizedConfig);
    case "content_based":
      return new ContentBasedStrategy(lookup, config as ContentBasedConfig);
    case "abtest":
      return new AbTestStrategy(lookup, config as AbTestConfig);
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown strategy mode: ${String(_exhaustive)}`);
    }
  }
}
