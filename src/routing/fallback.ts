/**
 * Fallback strategy — tries targets in order, advancing on failure.
 */

import type { IStrategy, StrategyMode, ProviderLookup } from "./types.js";
import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  IStreamProvider,
} from "../providers/types.js";
import type { FallbackConfig } from "./strategy-factory.js";

export class FallbackStrategy implements IStrategy {
  public readonly mode: StrategyMode = "fallback";
  private readonly targets: readonly string[];
  private readonly lookup: ProviderLookup;

  constructor(lookup: ProviderLookup, config: FallbackConfig) {
    this.lookup = lookup;
    this.targets = config.targets;
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return [...this.targets];
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    let lastError: unknown;
    for (const name of this.targets) {
      const provider = this.lookup(name);
      if (!provider) continue;
      try {
        return await provider.complete(ctx, req);
      } catch (err: unknown) {
        lastError = err;
        continue;
      }
    }
    throw new FallbackExhaustedError(
      `FallbackStrategy: all ${this.targets.length} targets failed`,
      lastError,
    );
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    let lastError: unknown;
    for (const name of this.targets) {
      const provider = this.lookup(name);
      if (!provider || !("completeStream" in provider)) continue;
      try {
        const stream = (provider as IStreamProvider).completeStream(ctx, req);
        yield* stream;
        return;
      } catch (err: unknown) {
        lastError = err;
        continue;
      }
    }
    throw new FallbackExhaustedError(
      `FallbackStrategy: all ${this.targets.length} streaming targets failed`,
      lastError,
    );
  }
}

export class FallbackExhaustedError extends Error {
  public override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "FallbackExhaustedError";
    this.cause = cause;
  }
}
