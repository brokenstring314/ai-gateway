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
import type { RetryConfig } from "../config/types.js";
import { executeCandidates, streamCandidates, type CandidateHooks } from "./executor.js";

export class FallbackStrategy implements IStrategy {
  public readonly mode: StrategyMode = "fallback";
  private readonly targets: readonly string[];
  private readonly lookup: ProviderLookup;
  private readonly retryConfigs: ReadonlyMap<string, RetryConfig>;

  constructor(lookup: ProviderLookup, config: FallbackConfig) {
    this.lookup = lookup;
    this.targets = config.targets;
    this.retryConfigs = config.retryConfigs ?? new Map();
  }

  selectTargets(_req: ChatCompletionRequest): string[] {
    return [...this.targets];
  }

  private hooks(streaming: boolean): CandidateHooks {
    return {
      label: "FallbackStrategy",
      // No explicit retry config means a single attempt for this target
      // (Go fallback default: no retries until WithTargetRetry).
      retryConfigFor: (name) => this.retryConfigs.get(name),
      exhausted: (lastError) => new FallbackExhaustedError(
        `FallbackStrategy: all ${this.targets.length} ${streaming ? "streaming " : ""}targets failed`,
        lastError,
      ),
    };
  }

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return executeCandidates(ctx, this.targets, this.lookup, (p) => p.complete(ctx, req), this.hooks(false));
  }

  async *executeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk> {
    yield* streamCandidates(
      ctx,
      this.targets,
      this.lookup,
      (p) => (p as IStreamProvider).completeStream(ctx, req),
      this.hooks(true),
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
