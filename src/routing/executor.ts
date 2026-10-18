/**
 * Shared candidate executor used by every multi-target routing strategy.
 *
 * A strategy only decides the ORDER of its candidate targets (preferred
 * first: cheapest, fastest, weighted pick, matched rule, ...). The executor
 * walks that list:
 *  - a missing provider (or one lacking the needed capability) is skipped;
 *  - each candidate is invoked with its own retry config (default: one
 *    attempt, no retry);
 *  - on a failover-eligible error (circuit open, concurrency limit, network,
 *    5xx, 408, 429, 401/403/404 — see outcome.isFailoverEligible) the next
 *    candidate is tried; any other error (caller-caused 4xx, client abort,
 *    gateway request timeout) is rethrown immediately;
 *  - streams fail over only before their first chunk: once output has been
 *    delivered, an error is rethrown as-is (splicing another target's answer
 *    onto a partial one would corrupt the response).
 */

import type { RetryConfig } from "../config/types.js";
import type { IProvider, RequestContext } from "../providers/types.js";
import type { ProviderLookup } from "./types.js";
import { isFailoverEligible } from "./outcome.js";
import { retryWithBackoff, RetryExhaustedError } from "./retry.js";

export interface CandidateHooks {
  /** Label used in log lines and error messages, e.g. "LoadBalanceStrategy". */
  readonly label: string;
  /** Per-target retry config; undefined means a single attempt. */
  readonly retryConfigFor?: (name: string) => RetryConfig | undefined;
  /** Called after a candidate succeeded (non-stream) or produced its first chunk (stream). */
  readonly onSuccess?: (name: string, elapsedMs: number) => void;
  /** Called after a candidate failed with a failover-eligible error. */
  readonly onFailure?: (name: string, err: unknown) => void;
  /**
   * Builds the error thrown when every candidate failed. Default: the last
   * candidate's error (RetryExhaustedError unwrapped to its cause).
   */
  readonly exhausted?: (lastError: unknown, tried: number) => unknown;
}

function unwrapRetry(err: unknown): unknown {
  return err instanceof RetryExhaustedError ? err.cause : err;
}

function abortedError(ctx: RequestContext): unknown {
  const reason = ctx?.signal?.reason;
  return reason ?? new DOMException("Aborted", "AbortError");
}

async function attempt<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
  retry: RetryConfig | undefined,
): Promise<T> {
  // A single attempt calls fn directly so the provider's own error surfaces
  // unwrapped (retryWithBackoff wraps exhaustion in RetryExhaustedError).
  if (!retry || (retry.attempts ?? 1) <= 1) return fn();
  return retryWithBackoff(fn, retry, ctx?.signal);
}

function finish(hooks: CandidateHooks, label: string, lastError: unknown, tried: number): never {
  if (hooks.exhausted) throw hooks.exhausted(lastError, tried);
  if (tried === 0) {
    throw lastError ?? new Error(`${hooks.label}: no ${label}provider available`);
  }
  throw unwrapRetry(lastError);
}

/**
 * Run a non-streaming operation over the candidates in order.
 * `invoke` returns undefined when the provider cannot serve this operation
 * (missing capability); that candidate is skipped.
 */
export async function executeCandidates<T>(
  ctx: RequestContext,
  candidates: readonly string[],
  lookup: ProviderLookup,
  invoke: (provider: IProvider, name: string) => Promise<T>,
  hooks: CandidateHooks,
  supports: (provider: IProvider) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  let tried = 0;
  for (const name of candidates) {
    if (ctx?.signal?.aborted) throw lastError ?? abortedError(ctx);
    const provider = lookup(name);
    if (!provider) {
      lastError ??= new Error(`${hooks.label}: provider "${name}" not found`);
      continue;
    }
    if (!supports(provider)) {
      lastError ??= new Error(`${hooks.label}: provider "${name}" does not support this operation`);
      continue;
    }
    tried++;
    const start = performance.now();
    try {
      const result = await attempt(ctx, () => invoke(provider, name), hooks.retryConfigFor?.(name));
      hooks.onSuccess?.(name, performance.now() - start);
      return result;
    } catch (err) {
      lastError = err;
      if (!isFailoverEligible(err) || ctx?.signal?.aborted) throw unwrapRetry(err);
      hooks.onFailure?.(name, err);
      console.error(`${hooks.label}: target "${name}" failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return finish(hooks, "", lastError, tried);
}

/**
 * Run a streaming operation over the candidates in order. Each candidate's
 * stream is opened and its first chunk pulled eagerly (with retry), so a
 * pre-output failure can fail over; after the first chunk the stream is
 * passed through and any error is rethrown.
 */
export async function* streamCandidates<C>(
  ctx: RequestContext,
  candidates: readonly string[],
  lookup: ProviderLookup,
  open: (provider: IProvider, name: string) => AsyncIterable<C>,
  hooks: CandidateHooks,
  supports: (provider: IProvider) => boolean = (p) => "completeStream" in p,
): AsyncGenerator<C> {
  let lastError: unknown;
  let tried = 0;
  for (const name of candidates) {
    if (ctx?.signal?.aborted) throw lastError ?? abortedError(ctx);
    const provider = lookup(name);
    if (!provider) {
      lastError ??= new Error(`${hooks.label}: streaming provider "${name}" not found`);
      continue;
    }
    if (!supports(provider)) {
      lastError ??= new Error(`${hooks.label}: provider "${name}" does not support streaming`);
      continue;
    }
    tried++;
    const start = performance.now();
    let opened: { iterator: AsyncIterator<C>; first: IteratorResult<C> };
    try {
      opened = await attempt(
        ctx,
        async () => {
          const iterator = open(provider, name)[Symbol.asyncIterator]();
          try {
            const first = await iterator.next();
            return { iterator, first };
          } catch (err) {
            await iterator.return?.().catch(() => undefined);
            throw err;
          }
        },
        hooks.retryConfigFor?.(name),
      );
    } catch (err) {
      lastError = err;
      if (!isFailoverEligible(err) || ctx?.signal?.aborted) throw unwrapRetry(err);
      hooks.onFailure?.(name, err);
      console.error(`${hooks.label}: streaming target "${name}" failed:`, err instanceof Error ? err.message : String(err));
      continue;
    }

    const { iterator, first } = opened;
    hooks.onSuccess?.(name, performance.now() - start);
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
  return finish(hooks, "streaming ", lastError, tried);
}
