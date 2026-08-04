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

export class CostOptimizedStrategy implements IStrategy {
  public readonly mode: StrategyMode = "cost_optimized";
  private readonly targets: readonly CostOptimizedTarget[];
  private readonly unpricedStrategy: "fallback" | "skip" | "allow";
  private readonly lookup: ProviderLookup;

  constructor(lookup: ProviderLookup, config: CostOptimizedConfig) {
    this.lookup = lookup;
    this.targets = config.targets;
    this.unpricedStrategy = config.unpricedStrategy ?? "fallback";
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return this.targetsSortedByCostRanked().map((t) => t.name);
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const target = this.pickCheapest();
    const provider = this.lookup(target.name);
    if (!provider) {
      throw new Error(
        `CostOptimizedStrategy: provider "${target.name}" not found`,
      );
    }
    return provider.complete(ctx, req);
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const target = this.pickCheapest();
    const provider = this.lookup(target.name);
    if (!provider || !("completeStream" in provider)) {
      throw new Error(
        `CostOptimizedStrategy: streaming provider "${target.name}" not found`,
      );
    }
    yield* (provider as IStreamProvider).completeStream(ctx, req);
  }

  private pickCheapest(): CostOptimizedTarget {
    const ranked = this.targetsSortedByCostRanked();
    if (ranked.length === 0) {
      throw new Error(
        "CostOptimizedStrategy: no priced targets configured",
      );
    }
    return ranked[0]!;
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
