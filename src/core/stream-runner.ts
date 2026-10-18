/**
 * Stream runner (refactor plan §1.1, PR 2.5).
 *
 * executeStream(): opens the strategy's candidates through core/executor
 * and pulls the first chunk. Before that chunk every failure (HTTP error,
 * zero chunks, a non-SSE 200, truncation, timeout before output) is a failed
 * attempt and may fail over to the next candidate; after it the target is
 * fixed. The result is a StreamResult whose settle(end) runs the caller's
 * finalize exactly once, however the stream ends (done / truncated /
 * upstream_error / idle_timeout / client_cancel).
 *
 * iterateStream(): consumes a StreamResult as an async generator and
 * settles it with the right StreamEnd (also on early return()).
 *
 * createSseStream(): the SSE response writer shared by the streaming chat
 * and legacy completions handlers, so the two endpoints can't drift apart:
 *
 *  - pull-based body: one upstream chunk is read per pull(), so a client that
 *    stops reading stops upstream reads too (TCP backpressure to upstream)
 *    instead of the gateway buffering the whole answer in memory;
 *  - `: ping` heartbeat while upstream is silent, enqueued only when the
 *    stream queue has room (never grows the buffer for a stalled client);
 *  - client disconnect (body cancel) aborts the upstream request and stops
 *    the provider iterator;
 *  - upstream idle timeout (and optional max stream duration): once the SSE
 *    Response is returned the request timeout no longer applies, so a hung
 *    upstream would otherwise hold its socket and concurrency slot forever.
 *    On expiry the upstream is aborted with a TimeoutError reason (breaker:
 *    timeout after output started counts as neither success nor failure),
 *    the iterator is released, and the client gets an SSE error event with
 *    no [DONE] so it can tell the answer is incomplete;
 *  - an upstream error after output (truncated stream, broken event, …)
 *    becomes an SSE error event, also without [DONE];
 *  - [DONE] is written only for a stream that completed (the parser stops at
 *    the upstream's [DONE], so the client gets it immediately).
 */

import type { IProvider, RequestContext } from "../providers/types.js";
import { isTruncatedStreamError, ReadableStreamError } from "../providers/sse-parser.js";
import type { StreamEnd, StreamEndReason, StreamResult } from "./types.js";
import type { RunOptions, TargetExecutor } from "./executor.js";
import { isAbortError, isTimeoutAbort } from "./outcome.js";
import { createTimeoutReason } from "./outcome.js";
import { errorToSseEvent, logGatewayError, toGatewayError } from "./errors.js";
import { startSseHeartbeat, type SseHeartbeat } from "../handlers/sse-heartbeat.js";

export const DONE_MESSAGE = "data: [DONE]\n\n";

/** Default upstream idle timeout for streams (reasoning models can pause long). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS = 120;

/** Resolve a seconds setting to ms; 0 / negative / non-finite disables it. */
function secondsToMs(seconds: number | undefined, fallback: number): number {
  const s = seconds ?? fallback;
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0;
}

export function streamIdleTimeoutMs(seconds: number | undefined): number {
  return secondsToMs(seconds, DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS);
}

export function streamMaxDurationMs(seconds: number | undefined): number {
  return secondsToMs(seconds, 0);
}

export interface SseStreamOptions<T> {
  /** Provider iterator, already primed with its first chunk. */
  iterator: AsyncIterator<T>;
  /** First chunk read while priming (undefined if the stream was empty). */
  firstChunk: T | undefined;
  /** Serialize one chunk to its SSE `data:` payload (JSON value). */
  serialize: (chunk: T) => unknown;
  /** Aborts the upstream request. */
  upstreamAbort: AbortController;
  heartbeatMs: number;
  /** Max silence between upstream chunks before giving up (0 = off). */
  idleTimeoutMs: number;
  /** Max total stream duration (0 = off). */
  maxDurationMs: number;
}

type TimeoutKind = "idle" | "max_duration";

function sseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function createSseStream<T>(opts: SseStreamOptions<T>): ReadableStream<Uint8Array> {
  const { iterator, serialize, upstreamAbort, heartbeatMs, idleTimeoutMs, maxDurationMs } = opts;
  const encoder = new TextEncoder();
  let pending: T | undefined = opts.firstChunk;
  let hasPending = opts.firstChunk !== undefined;
  let finished = false;
  let heartbeat: SseHeartbeat | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;

  const cleanup = (): void => {
    finished = true;
    heartbeat?.stop();
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    idleTimer = maxTimer = undefined;
  };

  const releaseIterator = (): void => {
    // Queued behind a pending next(); the abort makes that one settle.
    void Promise.resolve()
      .then(() => iterator.return?.(undefined))
      .catch(() => {});
  };

  const failWithTimeout = (kind: TimeoutKind): void => {
    if (finished) return;
    const ms = kind === "idle" ? idleTimeoutMs : maxDurationMs;
    cleanup();
    // TimeoutError reason: the breaker treats a timeout after output started
    // as neither success nor failure (see gateway guardProvider).
    upstreamAbort.abort(createTimeoutReason(ms));
    releaseIterator();
    const message =
      kind === "idle" ? `Upstream stream idle for more than ${ms}ms` : `Stream exceeded maximum duration of ${ms}ms`;
    const code = kind === "idle" ? "stream_idle_timeout" : "stream_max_duration";
    try {
      ctrl?.enqueue(encoder.encode(sseData({ error: { message, type: "timeout_error", code } })));
      ctrl?.close();
    } catch {
      // already closed/cancelled
    }
  };

  const startTimer = (ms: number, kind: TimeoutKind): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => failWithTimeout(kind), ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        ctrl = controller;
        heartbeat = startSseHeartbeat(controller, heartbeatMs);
        if (maxDurationMs > 0) maxTimer = startTimer(maxDurationMs, "max_duration");
      },
      async pull(controller) {
        if (finished) return;
        if (hasPending) {
          hasPending = false;
          const chunk = pending as T;
          pending = undefined;
          controller.enqueue(encoder.encode(sseData(serialize(chunk))));
          heartbeat?.touch();
          return;
        }
        // The idle clock only runs while we wait on upstream: a client that
        // is not reading (no pull) must not be blamed on the upstream.
        if (idleTimeoutMs > 0) idleTimer = startTimer(idleTimeoutMs, "idle");
        let result: IteratorResult<T>;
        try {
          result = await iterator.next();
        } catch (err) {
          if (finished) return;
          cleanup();
          const gatewayError = toGatewayError(err);
          logGatewayError(gatewayError, "stream");
          // No [DONE] after an error: the client must be able to tell the
          // answer is incomplete (truncated stream, broken event, …; T3-4).
          controller.enqueue(encoder.encode(errorToSseEvent(gatewayError)));
          controller.close();
          return;
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        if (finished) return;
        if (result.done) {
          cleanup();
          controller.enqueue(encoder.encode(DONE_MESSAGE));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(sseData(serialize(result.value))));
        heartbeat?.touch();
      },
      cancel() {
        // Client went away: abort the upstream request and stop the provider
        // iterator so no more upstream tokens are produced.
        if (finished) return;
        cleanup();
        upstreamAbort.abort();
        releaseIterator();
      },
    },
    // One chunk of read-ahead; pull() is not called again until the client
    // drains it, so upstream reads stop when the client stops reading.
    { highWaterMark: 1 },
  );
}

// ── executeStream / iterateStream ──

/** What to stream: the candidates in order and how to open one. */
export interface StreamPlan<C> {
  readonly executor: TargetExecutor;
  readonly candidates: readonly string[];
  readonly open: (provider: IProvider, name: string) => AsyncIterable<C>;
  readonly run: RunOptions;
}

export interface ExecuteStreamHooks {
  /**
   * Runs exactly once when the stream ends (or fails before its first
   * chunk): after/onError plugins, request log, metrics. `target` is the
   * target that produced the first chunk (undefined if none did). Errors it
   * throws are logged, never surfaced to the client.
   */
  readonly finalize: (end: StreamEnd, target: string | undefined) => Promise<void>;
  /** Maps an error before it is settled and rethrown (e.g. to a GatewayError). */
  readonly mapError?: (err: unknown) => unknown;
}

/** How a stream that threw ended (plan §1.4). */
export function streamEndReason(
  err: unknown,
  signal: AbortSignal | null | undefined,
  started: boolean,
): StreamEndReason {
  if (isTruncatedStreamError(err)) return "truncated";
  if (started && isTimeoutAbort(signal)) return "idle_timeout";
  if (isAbortError(err) || (signal?.aborted && !isTimeoutAbort(signal))) return "client_cancel";
  return "upstream_error";
}

function onceSettle(hooks: ExecuteStreamHooks, target: () => string | undefined): (end: StreamEnd) => Promise<void> {
  let settled: Promise<void> | undefined;
  return (end) => {
    settled ??= hooks.finalize(end, target()).catch((err) => {
      console.error(`[stream] finalize failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return settled;
  };
}

/**
 * Open the stream over the plan's candidates and pull its first chunk.
 * Rejects (after settling) when no candidate produced a chunk.
 */
export async function executeStream<C>(
  ctx: RequestContext,
  plan: StreamPlan<C>,
  hooks: ExecuteStreamHooks,
): Promise<StreamResult<C>> {
  let target: string | undefined;
  const settle = onceSettle(hooks, () => target);
  const mapError = hooks.mapError ?? ((e: unknown) => e);
  const iterator = plan.executor
    .stream(ctx, plan.candidates, plan.open, {
      ...plan.run,
      onServed: (name) => {
        target = name;
        plan.run.onServed?.(name);
      },
    })
    [Symbol.asyncIterator]();

  let first: IteratorResult<C>;
  try {
    first = await iterator.next();
  } catch (err) {
    const mapped = mapError(err);
    await settle({ reason: streamEndReason(err, ctx?.signal, false), error: mapped });
    throw mapped;
  }
  if (first.done) {
    // The executor treats a chunkless stream as a failed attempt, so this
    // only happens with no candidates at all; never an empty success.
    const err = new ReadableStreamError("upstream stream ended without any chunk", "upstream_empty_stream");
    await settle({ reason: "upstream_error", error: err });
    throw err;
  }
  return {
    kind: "stream",
    first: first.value,
    rest: iterator,
    target: target ?? "unknown",
    settle,
  };
}

/**
 * Yield a StreamResult's chunks (first, then rest) and settle it once:
 * done on normal end; truncated / upstream_error / idle_timeout /
 * client_cancel when the upstream throws; client_cancel (or idle_timeout
 * when the gateway's idle timer aborted the request) on early return().
 */
export async function* iterateStream<C>(
  result: StreamResult<C>,
  signal?: AbortSignal | null,
  mapError: (err: unknown) => unknown = (e) => e,
): AsyncGenerator<C> {
  let ended = false;
  try {
    yield result.first;
    while (true) {
      let next: IteratorResult<C>;
      try {
        next = await result.rest.next();
      } catch (err) {
        ended = true;
        const mapped = mapError(err);
        await result.settle({ reason: streamEndReason(err, signal, true), error: mapped });
        throw mapped;
      }
      if (next.done) {
        ended = true;
        await result.settle({ reason: "done" });
        return;
      }
      yield next.value;
    }
  } finally {
    if (!ended) {
      // Consumer stopped early: release the upstream (limiter slot, breaker
      // permit, socket) before finalizing.
      await result.rest.return?.(undefined)?.catch(() => undefined);
      await result.settle({ reason: isTimeoutAbort(signal) ? "idle_timeout" : "client_cancel" });
    }
  }
}
