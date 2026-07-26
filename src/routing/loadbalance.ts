/**
 * LoadBalance strategy — weighted random selection across targets.
 */

import type { IStrategy, StrategyMode, ProviderLookup } from "./types.js";
import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  IStreamProvider,
} from "../providers/types.js";
import type { LoadBalanceConfig, LoadBalanceTarget } from "./strategy-factory.js";

export class LoadBalanceStrategy implements IStrategy {
  public readonly mode: StrategyMode = "loadbalance";
  private readonly targets: readonly LoadBalanceTarget[];
  private readonly lookup: ProviderLookup;

  constructor(lookup: ProviderLookup, config: LoadBalanceConfig) {
    this.lookup = lookup;
    this.targets = config.targets;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    const totalWeight = this.targets.reduce((s, t) => s + t.weight, 0);
    if (totalWeight <= 0) return [...this.targets].map((t) => t.name);

    // Weighted shuffle: sort by weight-adjusted random score descending
    const shuffled = [...this.targets]
      .map((t) => ({
        name: t.name,
        score: Math.random() * (t.weight / totalWeight),
      }))
      .sort((a, b) => b.score - a.score)
      .map((t) => t.name);

    return shuffled;
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const picked = this.pickWeighted();
    const provider = this.lookup(picked);
    if (!provider) {
      throw new Error(
        `LoadBalanceStrategy: provider "${picked}" not found`,
      );
    }
    return provider.complete(ctx, req);
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const picked = this.pickWeighted();
    const provider = this.lookup(picked);
    if (!provider || !("completeStream" in provider)) {
      throw new Error(
        `LoadBalanceStrategy: streaming provider "${picked}" not found`,
      );
    }
    yield* (provider as IStreamProvider).completeStream(ctx, req);
  }

  private pickWeighted(): string {
    const totalWeight = this.targets.reduce((s, t) => s + t.weight, 0);
    if (totalWeight <= 0 && this.targets.length > 0) {
      return this.targets[0]!.name;
    }

    let r = Math.random() * totalWeight;
    for (const target of this.targets) {
      r -= target.weight;
      if (r <= 0) return target.name;
    }
    // Fallback to last
    return this.targets[this.targets.length - 1]!.name;
  }
}
