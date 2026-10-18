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
  /** Per-target retry config used by the shared candidate executor. */
  readonly retryConfigs?: ReadonlyMap<string, RetryConfig>;
}

export interface ConditionalRule {
  readonly field: string;
  readonly pattern: string;
  readonly target: string;
}

export interface ConditionalConfig {
  readonly rules: readonly ConditionalRule[];
  readonly defaultTarget?: string;
  /** Per-target retry config used by the shared candidate executor. */
  readonly retryConfigs?: ReadonlyMap<string, RetryConfig>;
}

export interface LeastLatencyConfig {
  readonly targets: readonly string[];
  readonly windowSize?: number;
  /** How long a target that just failed is ranked last (default 30000 ms). */
  readonly failurePenaltyMs?: number;
  /** Per-target retry config used by the shared candidate executor. */
  readonly retryConfigs?: ReadonlyMap<string, RetryConfig>;
}

export type UnpricedStrategy = "fallback" | "skip" | "allow";

export interface CostOptimizedTarget {
  readonly name: string;
  readonly costPer1kInputTokens: number;
  readonly costPer1kOutputTokens: number;
}

export interface CostOptimizedConfig {
  readonly targets: readonly CostOptimizedTarget[];
  /**
   * How unpriced targets (no per-1k cost data) are treated, mirroring the Go
   * unpriced_strategy config: "fallback" (default) ranks priced targets and
   * only falls back to an unpriced target when nothing is priced; "skip" makes
   * "no priced targets" an error; "allow" ranks unpriced targets as zero-cost.
   */
  readonly unpricedStrategy?: UnpricedStrategy;
  /** Per-target retry config used by the shared candidate executor. */
  readonly retryConfigs?: ReadonlyMap<string, RetryConfig>;
}

export interface ContentBasedMapping {
  readonly keyword: string;
  readonly target: string;
}

export type ContentConditionType =
  | "prompt_contains"
  | "prompt_not_contains"
  | "prompt_regex";

export interface ContentBasedRule {
  readonly type: ContentConditionType;
  readonly value: string;
  readonly target: string;
}

export interface ContentBasedConfig {
  /** Legacy keyword → target mappings (last defined keyword wins). */
  readonly keywords?: readonly ContentBasedMapping[];
  /** Ordered Go-style content conditions (first match wins). */
  readonly contentConditions?: readonly ContentBasedRule[];
  readonly defaultTarget?: string;
  /** Per-target retry config used by the shared candidate executor. */
  readonly retryConfigs?: ReadonlyMap<string, RetryConfig>;
}

export interface AbTestVariant {
  readonly name: string;
  readonly weight: number;
}

export interface AbTestConfig {
  readonly variants: readonly AbTestVariant[];
  /** Per-target retry config used by the shared candidate executor. */
  readonly retryConfigs?: ReadonlyMap<string, RetryConfig>;
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
