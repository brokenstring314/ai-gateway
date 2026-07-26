/**
 * ABTest strategy — weighted random traffic splitting across variants.
 */

import type { IStrategy, StrategyMode, ProviderLookup } from "./types.js";
import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  IStreamProvider,
} from "../providers/types.js";
import type { AbTestConfig, AbTestVariant } from "./strategy-factory.js";

export class AbTestStrategy implements IStrategy {
  public readonly mode: StrategyMode = "abtest";
  private readonly variants: readonly AbTestVariant[];
  private readonly lookup: ProviderLookup;

  constructor(lookup: ProviderLookup, config: AbTestConfig) {
    this.lookup = lookup;
    this.variants = config.variants;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    const picked = this.pickVariant().name;
    const others = this.variants
      .map((v) => v.name)
      .filter((n) => n !== picked);
    return [picked, ...others];
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const picked = this.pickVariant();
    const provider = this.lookup(picked.name);
    if (!provider) {
      throw new Error(
        `AbTestStrategy: provider "${picked.name}" not found`,
      );
    }
    return provider.complete(ctx, req);
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    const picked = this.pickVariant();
    const provider = this.lookup(picked.name);
    if (!provider || !("completeStream" in provider)) {
      throw new Error(
        `AbTestStrategy: streaming provider "${picked.name}" not found`,
      );
    }
    yield* (provider as IStreamProvider).completeStream(ctx, req);
  }

  private pickVariant(): AbTestVariant {
    const totalWeight = this.variants.reduce((s, v) => s + v.weight, 0);
    if (totalWeight <= 0 && this.variants.length > 0) {
      return this.variants[0]!;
    }

    let r = Math.random() * totalWeight;
    for (const variant of this.variants) {
      r -= variant.weight;
      if (r <= 0) return variant;
    }
    return this.variants[this.variants.length - 1]!;
  }
}
