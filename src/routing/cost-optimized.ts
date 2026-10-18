/**
 * CostOptimized strategy — routes to the cheapest target that supports the model.
 *
 * Mirrors the Go cost-optimized strategy: targets without pricing data are
 * handled according to the configured unpriced strategy:
 *   - "fallback" (default): priced targets rank first; when no priced target
 *     exists, the first declared target is used.
 *   - "skip": only priced targets are eligible; no priced target is an error.
 *   - "allow": unpriced targets rank as normal zero-cost candidates.
 */

import type { IStrategy, StrategyMode, ProviderLookup } from "./types.js";
import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  IStreamProvider,
} from "../providers/types.js";
import type {
  CostOptimizedConfig,
  CostOptimizedTarget,
} from "./strategy-factory.js";
import type { RetryConfig } from "../config/types.js";
import { executeCandidates, streamCandidates, type CandidateHooks } from "./executor.js";

export class CostOptimizedStrategy implements IStrategy {
  public readonly mode: StrategyMode = "cost_optimized";
  private readonly targets: readonly CostOptimizedTarget[];
  private readonly unpricedStrategy: "fallback" | "skip" | "allow";
  private readonly lookup: ProviderLookup;
  private readonly retryConfigs: ReadonlyMap<string, RetryConfig>;

  constructor(lookup: ProviderLookup, config: CostOptimizedConfig) {
    this.lookup = lookup;
    this.retryConfigs = config.retryConfigs ?? new Map();
    this.targets = config.targets;
    this.unpricedStrategy = config.unpricedStrategy ?? "fallback";
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return this.targetsSortedByCostRanked().map((t) => t.name);
  }

  private hooks(): CandidateHooks {
    return {
      label: "CostOptimizedStrategy",
      retryConfigFor: (name) => this.retryConfigs.get(name),
    };
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return executeCandidates(ctx, this.candidates(), this.lookup, (p) => p.complete(ctx, req), this.hooks());
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    yield* streamCandidates(
      ctx,
      this.candidates(),
      this.lookup,
      (p) => (p as IStreamProvider).completeStream(ctx, req),
      this.hooks(),
    );
  }

  /**
   * Execution candidates: the cost ranking first, then (in "fallback" mode)
   * the unpriced targets in declared order as last-resort failover targets.
   * "skip" mode never uses unpriced targets.
   */
  private candidates(): string[] {
    const ranked = this.targetsSortedByCostRanked().map((t) => t.name);
    if (ranked.length === 0) {
      throw new Error(
        "CostOptimizedStrategy: no priced targets configured",
      );
    }
    if (this.unpricedStrategy !== "fallback") return ranked;
    const rest = this.targets.map((t) => t.name).filter((n) => !ranked.includes(n));
    return [...ranked, ...rest];
  }


  private isPriced(target: CostOptimizedTarget): boolean {
    return target.costPer1kInputTokens > 0 || target.costPer1kOutputTokens > 0;
  }

  /**
   * Rank targets by estimated cost. When the unpriced strategy is "fallback"
   * or "skip", unpriced targets (no per-1k cost data) are excluded from the
   * ranked prefix; in fallback mode an all-unpriced target set falls back to
   * the first declared target, and in skip mode it yields an empty ranked list
   * so pickCheapest reports the "no priced targets" error. In "allow" mode
   * every target ranks with its cost (unpriced == 0, i.e. cheapest).
   */
  private targetsSortedByCostRanked(): CostOptimizedTarget[] {
    const items = [...this.targets];
    if (this.unpricedStrategy === "allow") {
      return items.sort(compareByCost);
    }

    const priced = items.filter((t) => this.isPriced(t));
    if (priced.length === 0) {
      if (this.unpricedStrategy === "skip") return [];
      return items.length > 0 ? [items[0]!] : [];
    }
    return priced.sort(compareByCost);
  }
}

function compareByCost(a: CostOptimizedTarget, b: CostOptimizedTarget): number {
  return (
    a.costPer1kInputTokens - b.costPer1kInputTokens ||
    a.costPer1kOutputTokens - b.costPer1kOutputTokens
  );
}
