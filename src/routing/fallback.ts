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
import { retryWithBackoff } from "./retry.js";

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

  async execute(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    let lastError: unknown;
    for (const name of this.targets) {
      const provider = this.lookup(name);
      if (!provider) continue;
      try {
        // No explicit retry config means a single attempt for this target
        // (Go fallback default: no retries until WithTargetRetry).
        const retryCfg = this.retryConfigs.get(name) ?? { attempts: 1 };
        return await retryWithBackoff(
          () => provider.complete(ctx, req),
          retryCfg,
          ctx.signal,
        );
      } catch (err: unknown) {
        lastError = err;
        console.error(`FallbackStrategy: target "${name}" failed:`, err instanceof Error ? err.message : String(err));
        if (isNonRetryableError(err)) throw err;
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
        const retryCfg = this.retryConfigs.get(name) ?? { attempts: 1 };
        const stream = await retryWithBackoff(
          () => Promise.resolve((provider as IStreamProvider).completeStream(ctx, req)),
          retryCfg,
          ctx.signal,
        );
        yield* stream;
        return;
      } catch (err: unknown) {
        lastError = err;
        console.error(`FallbackStrategy: streaming target "${name}" failed:`, err instanceof Error ? err.message : String(err));
        if (isNonRetryableError(err)) throw err;
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

function isNonRetryableError(err: unknown): boolean {
  if (err !== null && typeof err === "object" && "statusCode" in err) {
    const status = (err as { statusCode: number }).statusCode;
    return status >= 400 && status < 500 && status !== 429;
  }
  return false;
}
