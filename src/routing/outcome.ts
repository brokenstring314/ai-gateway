/**
 * Classification of an upstream attempt's outcome for circuit-breaker
 * accounting, plus helpers telling the gateway's own request timeout apart
 * from a client disconnect.
 */

/** Name of the DOMException used as the abort reason for request timeouts. */
export const TIMEOUT_ERROR_NAME = "TimeoutError";

/** Abort reason the request-timeout middleware passes to controller.abort(). */
export function createTimeoutReason(timeoutMs?: number): DOMException {
  const suffix = timeoutMs !== undefined ? ` after ${timeoutMs}ms` : "";
  return new DOMException(`Request timed out${suffix}`, TIMEOUT_ERROR_NAME);
}

export function isAbortError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}

export function isTimeoutError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === TIMEOUT_ERROR_NAME;
}

/** True when `signal` was aborted by the gateway's request timeout (not by the client). */
export function isTimeoutAbort(signal: AbortSignal | undefined | null): boolean {
  return !!signal?.aborted && isTimeoutError(signal.reason);
}

/**
 * Whether an upstream error reflects target health and should count as a
 * breaker failure. Only transport errors (status 0 / non-HTTP errors), 5xx,
 * 408 and 429 count. Other 4xx are caused by the caller's request (bad
 * schema, unknown model, payload too large, ...) and must not let one
 * tenant open the circuit for everyone.
 */
export function isBreakerFailure(err: unknown): boolean {
  if (err !== null && typeof err === "object" && "statusCode" in err) {
    const status = (err as { statusCode: unknown }).statusCode;
    if (typeof status !== "number" || status === 0) return true;
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    return status < 400; // unexpected 1xx-3xx surfaced as an error: count it
  }
  return true;
}
