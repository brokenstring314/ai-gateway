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
        if (isNonRetryableError(err) || isAbortError(err)) throw err;
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
      // Open the stream and pull its first chunk eagerly, so pre-output
      // failures are retried / failed over. Once output has started, any
      // error is rethrown as-is: splicing another target's answer onto a
      // partially delivered one would corrupt the response.
      let opened: { iterator: AsyncIterator<StreamChunk>; first: IteratorResult<StreamChunk> };
      try {
        const retryCfg = this.retryConfigs.get(name) ?? { attempts: 1 };
        opened = await retryWithBackoff(
          async () => {
            const iterator = (provider as IStreamProvider).completeStream(ctx, req)[Symbol.asyncIterator]();
            const first = await iterator.next();
            return { iterator, first };
          },
          retryCfg,
          ctx.signal,
        );
      } catch (err: unknown) {
        lastError = err;
        console.error(`FallbackStrategy: streaming target "${name}" failed:`, err instanceof Error ? err.message : String(err));
        if (isNonRetryableError(err) || isAbortError(err)) throw err;
        continue;
      }

      const { iterator, first } = opened;
      if (first.done) return;
      let finished = false;
      try {
        yield first.value;
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            finished = true;
            return;
          }
          yield next.value;
        }
      } finally {
        if (!finished) await iterator.return?.();
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

function isAbortError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}
