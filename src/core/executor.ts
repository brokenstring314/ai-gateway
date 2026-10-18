/**
 * Target executor (refactor plan §1.1 step 5, PR 2.2).
 *
 * Strategies only ORDER candidate targets (IStrategy.selectTargets); this
 * executor runs them. It replaces the old provider decorator chain
 * (tagStreamProvider ∘ guardProvider ∘ limitProvider) and the round-3
 * candidate executor with one explicit attempt():
 *
 *   breaker.acquire() → limiter.acquire(signal) → call upstream
 *     → classifyAttemptError() → settle(permit) → fail over or not
 *
 *  - an OPEN breaker rejects without taking a limiter slot;
 *  - the limiter wait is abortable; a request that times out (or is
 *    rejected) while queued never reached upstream, so its breaker permit is
 *    released instead of being counted as an upstream failure (C3-3);
 *  - settlement passes the permit (C3-6);
 *  - per-target retry (TargetConfig.retry) wraps each candidate's attempts,
 *    for every strategy;
 *  - a failover-eligible error (core/outcome isFailoverEligible) moves on to
 *    the next candidate; anything else is rethrown at once;
 *  - streams fail over only before their first chunk; after it, errors are
 *    rethrown as-is;
 *  - when every candidate failed, the most meaningful attempt error is
 *    reported (core/errors mostMeaningful).
 */

import type { RetryConfig } from "../config/types.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  IProvider,
  IStreamProvider,
  RequestContext,
  StreamChunk,
} from "../providers/types.js";
import type { IStrategy, StrategyMode } from "../routing/types.js";
import { FallbackExhaustedError } from "../routing/fallback.js";
import { type CircuitBreaker, CircuitOpenError, type BreakerPermit } from "../routing/circuit-breaker.js";
import { type ConcurrencyLimiter, ConcurrencyLimitError } from "../routing/concurrency-limiter.js";
import { retryWithBackoff, RetryExhaustedError } from "../routing/retry.js";
import { classifyAttemptError, isFailoverEligible, isTimeoutAbort } from "./outcome.js";
import { GatewayError, gatewayTimeout, mostMeaningful } from "./errors.js";

export type ProviderLookup = (name: string) => IProvider | undefined;

export interface ExecutorDeps {
  readonly lookup: ProviderLookup;
  readonly breaker?: (name: string) => CircuitBreaker | undefined;
  readonly limiter?: (name: string) => ConcurrencyLimiter | undefined;
  /** Per-target retry; undefined means a single attempt. */
  readonly retryConfig?: (name: string) => RetryConfig | undefined;
}

export interface RunOptions {
  /** Label used in log lines and error messages, e.g. "Gateway(chat)". */
  readonly label: string;
  /** Whether a provider can serve this operation (missing capability → skipped). */
  readonly supports?: (provider: IProvider) => boolean;
  /** Builds the error thrown when every candidate failed (default: the chosen attempt error). */
  readonly exhausted?: (chosen: unknown, tried: number) => unknown;
  /** Called with the target that produced the result (non-stream) or the first chunk (stream). */
  readonly onServed?: (name: string) => void;
}

function unwrapRetry(err: unknown): unknown {
  return err instanceof RetryExhaustedError ? err.cause : err;
}

function abortedError(ctx: RequestContext): unknown {
  return ctx?.signal?.reason ?? new DOMException("Aborted", "AbortError");
}

function queueTimeout(target: string, cause: unknown): GatewayError {
  return new GatewayError("overloaded", {
    status: 429,
    message: "Timed out waiting for a free upstream slot; retry later",
    type: "rate_limit_error",
    code: "gateway_overloaded",
    target,
    retryAfter: "1",
    cause,
  });
}

interface Admission {
  readonly breaker: CircuitBreaker | undefined;
  readonly permit: BreakerPermit | null;
  readonly limiter: ConcurrencyLimiter | undefined;
}

export class TargetExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  // ── one attempt on one target ──

  /**
   * Take the breaker permit, then a limiter slot. Rejections (breaker OPEN,
   * queue full, aborted while queued) leave nothing held: the permit is
   * released, no slot is taken.
   */
  private async admit(name: string, ctx: RequestContext): Promise<Admission> {
    const breaker = this.deps.breaker?.(name);
    let permit: BreakerPermit | null = null;
    if (breaker) {
      permit = breaker.acquire();
      if (!permit) throw new CircuitOpenError(name, breaker.retryAfterSeconds());
    }
    const limiter = this.deps.limiter?.(name);
    if (!limiter) return { breaker, permit, limiter };
    try {
      let granted = limiter.acquire(ctx?.signal);
      if (granted instanceof Promise) granted = await granted;
      if (!granted) throw new ConcurrencyLimitError(name);
    } catch (err) {
      // Never reached upstream: no health signal (C3-3).
      breaker?.release(permit);
      // The gateway deadline fired while queued for a local slot: local
      // congestion, answered 429 gateway_overloaded (not an upstream timeout).
      if (isTimeoutAbort(ctx?.signal)) throw queueTimeout(name, err);
      throw err;
    }
    return { breaker, permit, limiter };
  }

  /** Settle a failed admitted attempt and return the error to rethrow. */
  private settleFailure(name: string, a: Admission, ctx: RequestContext, err: unknown, started: boolean): unknown {
    const c = classifyAttemptError(err, { signal: ctx?.signal, admitted: true, started });
    this.settle(a, c.breaker);
    return c.timedOut ? gatewayTimeout(name) : err;
  }

  private settle(a: Admission, how: "success" | "failure" | "release"): void {
    if (!a.breaker) return;
    if (how === "success") a.breaker.recordSuccess(a.permit);
    else if (how === "failure") a.breaker.recordFailure(a.permit);
    else a.breaker.release(a.permit);
  }

  private async attempt<T>(name: string, ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
    const a = await this.admit(name, ctx);
    try {
      const result = await fn();
      this.settle(a, "success");
      return result;
    } catch (err) {
      throw this.settleFailure(name, a, ctx, err, false);
    } finally {
      a.limiter?.release();
    }
  }

  /** Streaming attempt: the slot is held and the permit settled for the whole stream. */
  private async *attemptStream<C>(name: string, ctx: RequestContext, open: () => AsyncIterable<C>): AsyncGenerator<C> {
    const a = await this.admit(name, ctx);
    let started = false;
    let settled = false;
    try {
      for await (const chunk of open()) {
        started = true;
        yield chunk;
      }
      settled = true;
      this.settle(a, "success");
    } catch (err) {
      settled = true;
      throw this.settleFailure(name, a, ctx, err, started);
    } finally {
      // Consumer stopped early. With output, upstream was healthy; without
      // any, there is no signal: return the permit.
      if (!settled) this.settle(a, started ? "success" : "release");
      a.limiter?.release();
    }
  }

  private withRetry<T>(name: string, ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
    const retry = this.deps.retryConfig?.(name);
    // A single attempt calls fn directly so the attempt's own error surfaces
    // unwrapped (retryWithBackoff wraps exhaustion in RetryExhaustedError).
    if (!retry || (retry.attempts ?? 1) <= 1) return fn();
    return retryWithBackoff(fn, retry, ctx?.signal ?? undefined);
  }

  private finish(opts: RunOptions, kind: string, lastError: unknown, tried: number, errors: readonly unknown[]): never {
    const chosen = errors.length > 0 ? mostMeaningful(errors.map(unwrapRetry)) : lastError;
    if (opts.exhausted) throw opts.exhausted(chosen, tried);
    if (tried === 0) throw lastError ?? new Error(`${opts.label}: no ${kind}provider available`);
    throw unwrapRetry(chosen);
  }

  // ── candidates ──

  /** Run a non-streaming operation over the candidates in order. */
  async run<T>(
    ctx: RequestContext,
    candidates: readonly string[],
    call: (provider: IProvider, name: string) => Promise<T>,
    opts: RunOptions,
  ): Promise<T> {
    const supports = opts.supports ?? (() => true);
    let lastError: unknown;
    const errors: unknown[] = [];
    let tried = 0;
    for (const name of candidates) {
      if (ctx?.signal?.aborted) throw lastError ?? abortedError(ctx);
      const provider = this.deps.lookup(name);
      if (!provider) {
        lastError ??= new Error(`${opts.label}: provider "${name}" not found`);
        continue;
      }
      if (!supports(provider)) {
        lastError ??= new Error(`${opts.label}: provider "${name}" does not support this operation`);
        continue;
      }
      tried++;
      try {
        const result = await this.withRetry(name, ctx, () => this.attempt(name, ctx, () => call(provider, name)));
        opts.onServed?.(name);
        return result;
      } catch (err) {
        lastError = err;
        errors.push(err);
        if (!isFailoverEligible(err) || ctx?.signal?.aborted) throw unwrapRetry(err);
        console.error(`${opts.label}: target "${name}" failed:`, err instanceof Error ? err.message : String(err));
      }
    }
    return this.finish(opts, "", lastError, tried, errors);
  }

  /**
   * Run a streaming operation over the candidates in order. Each candidate's
   * stream is opened and its first chunk pulled eagerly (inside retry), so a
   * pre-output failure can fail over; after the first chunk the stream is
   * passed through and any error is rethrown.
   */
  async *stream<C>(
    ctx: RequestContext,
    candidates: readonly string[],
    open: (provider: IProvider, name: string) => AsyncIterable<C>,
    opts: RunOptions,
  ): AsyncGenerator<C> {
    const supports = opts.supports ?? ((p: IProvider) => "completeStream" in p);
    let lastError: unknown;
    const errors: unknown[] = [];
    let tried = 0;
    for (const name of candidates) {
      if (ctx?.signal?.aborted) throw lastError ?? abortedError(ctx);
      const provider = this.deps.lookup(name);
      if (!provider) {
        lastError ??= new Error(`${opts.label}: streaming provider "${name}" not found`);
        continue;
      }
      if (!supports(provider)) {
        lastError ??= new Error(`${opts.label}: provider "${name}" does not support streaming`);
        continue;
      }
      tried++;
      let opened: { iterator: AsyncIterator<C>; first: IteratorResult<C> };
      try {
        opened = await this.withRetry(name, ctx, async () => {
          const iterator = this.attemptStream(name, ctx, () => open(provider, name))[Symbol.asyncIterator]();
          try {
            return { iterator, first: await iterator.next() };
          } catch (err) {
            await iterator.return?.(undefined).catch(() => undefined);
            throw err;
          }
        });
      } catch (err) {
        lastError = err;
        errors.push(err);
        if (!isFailoverEligible(err) || ctx?.signal?.aborted) throw unwrapRetry(err);
        console.error(`${opts.label}: streaming target "${name}" failed:`, err instanceof Error ? err.message : String(err));
        continue;
      }

      const { iterator, first } = opened;
      if (!first.done) opts.onServed?.(name);
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
        if (!finished) await iterator.return?.(undefined);
      }
    }
    return this.finish(opts, "streaming ", lastError, tried, errors);
  }
}

// ── chat over a strategy ──

const STRATEGY_LABELS: Readonly<Record<StrategyMode, string>> = {
  single: "SingleStrategy",
  fallback: "FallbackStrategy",
  loadbalance: "LoadBalanceStrategy",
  conditional: "ConditionalStrategy",
};

/**
 * Run options for a strategy's candidates. A fallback chain that is
 * exhausted throws FallbackExhaustedError (its historical error type for
 * embedded callers; core/errors unwraps it before rendering).
 */
export function strategyRunOptions(
  strategy: IStrategy,
  streaming: boolean,
  candidateCount: number,
  onServed?: (name: string) => void,
): RunOptions {
  const label = STRATEGY_LABELS[strategy.mode] ?? strategy.mode;
  if (strategy.mode !== "fallback") return { label, onServed };
  return {
    label,
    onServed,
    exhausted: (chosen) =>
      new FallbackExhaustedError(`FallbackStrategy: all ${candidateCount} ${streaming ? "streaming " : ""}targets failed`, chosen),
  };
}

/** Non-streaming chat completion over the strategy's candidates. */
export async function executeChat(
  executor: TargetExecutor,
  strategy: IStrategy,
  ctx: RequestContext,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const candidates = strategy.selectTargets(req);
  return executor.run(ctx, candidates, (p) => p.complete(ctx, req), strategyRunOptions(strategy, false, candidates.length));
}

/** Streaming chat completion over the strategy's candidates; `onServed` names the target of the first chunk. */
export async function* streamChat(
  executor: TargetExecutor,
  strategy: IStrategy,
  ctx: RequestContext,
  req: ChatCompletionRequest,
  onServed?: (name: string) => void,
): AsyncGenerator<StreamChunk> {
  const candidates = strategy.selectTargets(req);
  yield* executor.stream(
    ctx,
    candidates,
    (p) => (p as IProvider & IStreamProvider).completeStream(ctx, req),
    strategyRunOptions(strategy, true, candidates.length, onServed),
  );
}
