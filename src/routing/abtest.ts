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
import type { RetryConfig } from "../config/types.js";
import { executeCandidates, streamCandidates, type CandidateHooks } from "./executor.js";

export class AbTestStrategy implements IStrategy {
  public readonly mode: StrategyMode = "abtest";
  private readonly variants: readonly AbTestVariant[];
  private readonly lookup: ProviderLookup;
  private readonly retryConfigs: ReadonlyMap<string, RetryConfig>;

  constructor(lookup: ProviderLookup, config: AbTestConfig) {
    this.lookup = lookup;
    this.retryConfigs = config.retryConfigs ?? new Map();
    this.variants = config.variants;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    const picked = this.pickVariant().name;
    const others = this.variants
      .map((v) => v.name)
      .filter((n) => n !== picked);
    return [picked, ...others];
  }

  private hooks(): CandidateHooks {
    return {
      label: "AbTestStrategy",
      retryConfigFor: (name) => this.retryConfigs.get(name),
    };
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return executeCandidates(ctx, this.selectTargets(req), this.lookup, (p) => p.complete(ctx, req), this.hooks());
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    yield* streamCandidates(
      ctx,
      this.selectTargets(req),
      this.lookup,
      (p) => (p as IStreamProvider).completeStream(ctx, req),
      this.hooks(),
    );
  }

  private pickVariant(): AbTestVariant {
    if (this.variants.length === 0) {
      throw new Error("AbTestStrategy: no variants configured");
    }

    // Zero/negative weights participate as weight 1 (equal distribution),
    // mirroring the Go effectiveWeight normalization.
    const totalWeight = this.variants.reduce(
      (s, v) => s + effectiveWeight(v.weight),
      0,
    );

    let r = Math.random() * totalWeight;
    for (const variant of this.variants) {
      r -= effectiveWeight(variant.weight);
      if (r <= 0) return variant;
    }
    return this.variants[this.variants.length - 1]!;
  }
}

function effectiveWeight(weight: number): number {
  return weight > 0 ? weight : 1;
}
