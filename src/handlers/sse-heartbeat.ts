/**
 * SSE keep-alive heartbeat.
 *
 * While a stream is idle (upstream silent, e.g. a reasoning model thinking),
 * an SSE comment line `: ping` is written every interval. Comments are
 * ignored by SSE/OpenAI clients but keep bytes flowing so neither Bun's
 * idleTimeout nor intermediary proxies cut the connection.
 */

export const SSE_PING = ": ping\n\n";

/** Default heartbeat interval when config.server.sseHeartbeatSeconds is unset. */
export const DEFAULT_SSE_HEARTBEAT_SECONDS = 5;

export interface SseHeartbeat {
  /** Record that real data was just written (resets the idle clock). */
  touch(): void;
  /** Stop the heartbeat; safe to call more than once. */
  stop(): void;
}

/** Resolve the heartbeat interval in ms; 0 disables the heartbeat. */
export function heartbeatIntervalMs(seconds: number | undefined): number {
  const s = seconds ?? DEFAULT_SSE_HEARTBEAT_SECONDS;
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0;
}

export function startSseHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  intervalMs: number,
): SseHeartbeat {
  if (!(intervalMs > 0)) return { touch() {}, stop() {} };
  const ping = new TextEncoder().encode(SSE_PING);
  let last = Date.now();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || Date.now() - last < intervalMs) return;
    try {
      controller.enqueue(ping);
      last = Date.now();
    } catch {
      // Stream closed or cancelled underneath us.
      stop();
    }
  }, Math.max(10, Math.floor(intervalMs / 2)));
  (timer as { unref?: () => void }).unref?.();
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }
  return {
    touch() {
      last = Date.now();
    },
    stop,
  };
}
