/**
 * CostOptimized strategy — routes to the cheapest target that supports the model.
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
  private readonly lookup: ProviderLookup;

  constructor(lookup: ProviderLookup, config: CostOptimizedConfig) {
    this.lookup = lookup;
    this.targets = config.targets;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return this.targetsSortedByCost();
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const target = this.pickCheapest(req.model);
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
    const target = this.pickCheapest(req.model);
    const provider = this.lookup(target.name);
    if (!provider || !("completeStream" in provider)) {
      throw new Error(
        `CostOptimizedStrategy: streaming provider "${target.name}" not found`,
      );
    }
    yield* (provider as IStreamProvider).completeStream(ctx, req);
  }

  private pickCheapest(_model: string): CostOptimizedTarget {
    const sorted = this.targetsSortedByCostRanked();
    if (sorted.length === 0) {
      throw new Error(
        "CostOptimizedStrategy: no priced targets configured",
      );
    }
    return sorted[0]!;
  }

  private targetsSortedByCost(): string[] {
    return this.targetsSortedByCostRanked().map((t) => t.name);
  }

  private targetsSortedByCostRanked(): CostOptimizedTarget[] {
    const items = [...this.targets];
    return items.sort(
      (a, b) =>
        a.costPer1kInputTokens - b.costPer1kInputTokens ||
        a.costPer1kOutputTokens - b.costPer1kOutputTokens,
    );
  }
}
