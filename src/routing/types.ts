/**
 * Routing strategy interfaces.
 */

import type { IProvider, ChatCompletionRequest } from "../providers/types.js";

export type StrategyMode =
  | "single"
  | "fallback"
  | "loadbalance"
  | "conditional";

/**
 * A routing strategy only ORDERS candidate targets for a request (preferred
 * first). Running them — breaker, concurrency limit, retry, failover — is the
 * job of core/executor.ts, the same for every strategy.
 */
export interface IStrategy {
  readonly mode: StrategyMode;
  /** Ordered candidate targets for this request; throws when none can serve it. */
  selectTargets(req: ChatCompletionRequest): readonly string[];
}

export type ProviderLookup = (name: string) => IProvider | undefined;
