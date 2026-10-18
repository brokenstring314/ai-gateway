/**
 * Strategy factory — creates routing strategies from config + provider lookup.
 * Also re-exports all strategy config types for convenience.
 */

import type { ProviderLookup, IStrategy, StrategyMode } from "./types.js";
import { SingleStrategy } from "./single.js";
import { FallbackStrategy } from "./fallback.js";
import { LoadBalanceStrategy } from "./loadbalance.js";
import { ConditionalStrategy } from "./conditional.js";
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

/** Request field a conditional rule matches on. */
export type ConditionalField = "model" | "user" | "message" | "prompt";

/**
 * A conditional rule matches when `field` matches `pattern` (a regex) or
 * contains `contains` (case-insensitive substring). Exactly one is set.
 *  - model / user: the request's model / user field
 *  - message: the first message's text content
 *  - prompt: the text of every user message (absorbs the removed content_based)
 */
export interface ConditionalRule {
  readonly field: ConditionalField | string;
  readonly pattern?: string;
  readonly contains?: string;
  readonly target: string;
}

export interface ConditionalConfig {
  readonly rules: readonly ConditionalRule[];
  readonly defaultTarget?: string;
  /** Per-target retry config used by the shared candidate executor. */
  readonly retryConfigs?: ReadonlyMap<string, RetryConfig>;
}

export type StrategyConfig =
  | SingleConfig
  | FallbackConfig
  | LoadBalanceConfig
  | ConditionalConfig;

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
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown strategy mode: ${String(_exhaustive)}`);
    }
  }
}
