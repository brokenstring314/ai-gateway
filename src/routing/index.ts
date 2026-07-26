/**
 * Routing module barrel export.
 */

export type { IStrategy, StrategyMode, ProviderLookup } from "./types.js";

export type {
  SingleConfig,
  FallbackConfig,
  LoadBalanceTarget,
  LoadBalanceConfig,
  ConditionalRule,
  ConditionalConfig,
  LeastLatencyConfig,
  CostOptimizedTarget,
  CostOptimizedConfig,
  ContentBasedMapping,
  ContentBasedConfig,
  AbTestVariant,
  AbTestConfig,
  StrategyConfig,
} from "./strategy-factory.js";

export { createStrategy } from "./strategy-factory.js";

export { SingleStrategy } from "./single.js";
export { FallbackStrategy, FallbackExhaustedError } from "./fallback.js";
export { LoadBalanceStrategy } from "./loadbalance.js";
export { ConditionalStrategy } from "./conditional.js";
export { LeastLatencyStrategy } from "./least-latency.js";
export { CostOptimizedStrategy } from "./cost-optimized.js";
export { ContentBasedStrategy } from "./content-based.js";
export { AbTestStrategy } from "./abtest.js";
