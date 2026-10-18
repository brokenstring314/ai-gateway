/**
 * Shared SSE response writer for the streaming chat and legacy completions
 * handlers, so the two endpoints can't drift apart:
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
 *    no [DONE] so it can tell the answer is incomplete.
 */

import { createTimeoutReason } from "../routing/outcome.js";
import { startSseHeartbeat, type SseHeartbeat } from "./sse-heartbeat.js";

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
    const message = kind === "idle"
      ? `Upstream stream idle for more than ${ms}ms`
      : `Stream exceeded maximum duration of ${ms}ms`;
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
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(sseData({ error: { message, type: "stream_error" } })));
          controller.enqueue(encoder.encode(DONE_MESSAGE));
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
