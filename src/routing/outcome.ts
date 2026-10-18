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

/** HTTP status of an upstream error, unwrapping retry/fallback wrappers. */
export function errorStatus(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur !== null && typeof cur === "object"; depth++) {
    if ("statusCode" in cur) {
      const status = (cur as { statusCode: unknown }).statusCode;
      return typeof status === "number" ? status : undefined;
    }
    const name = (cur as { name?: unknown }).name;
    if ((name === "RetryExhaustedError" || name === "FallbackExhaustedError") && "cause" in cur) {
      cur = (cur as { cause: unknown }).cause;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Upstream statuses caused by the TARGET rather than the caller's request:
 * 401/403 = the operator's credential for that target is revoked, expired or
 * not entitled (account / region blocked); 404 = the model or deployment
 * does not exist at that target. Another target may well serve the request.
 */
const TARGET_CAUSED_4XX: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * Whether an upstream error reflects target health and should count as a
 * breaker failure. Transport errors (status 0 / non-HTTP errors), 5xx, 408,
 * 429 and target credential/permission errors (401, 403) count: a target
 * with a revoked key keeps failing until an operator fixes it, so it must
 * be routed around. 404 does not count: it is usually model-specific (one
 * model missing at that target), so it must not take the target down for
 * every other model. Other 4xx (400, 409, 413, 422, ...) are caused by the
 * caller's request and must not let one tenant open the circuit for everyone.
 */
export function isBreakerFailure(err: unknown): boolean {
  if (err !== null && typeof err === "object" && "statusCode" in err) {
    const status = (err as { statusCode: unknown }).statusCode;
    if (typeof status !== "number" || status === 0) return true;
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    if (status === 401 || status === 403) return true;
    return status < 400; // unexpected 1xx-3xx surfaced as an error: count it
  }
  return true;
}

/**
 * Whether a failed attempt on one target should move on to the next
 * candidate target (fallback chains and every multi-target strategy).
 *
 *  - client abort / gateway request timeout: no (the request is over);
 *  - circuit open / local concurrency limit (no status): yes, skip the target;
 *  - transport errors, 5xx, 408, 429: yes;
 *  - 401 / 403 / 404 (target-caused, see TARGET_CAUSED_4XX): yes;
 *  - other 4xx (400, 409, 413, 422, ...): no, the caller's request is the
 *    problem and every target would reject it the same way.
 *
 * RetryExhaustedError / FallbackExhaustedError are classified by their cause.
 */
export function isFailoverEligible(err: unknown): boolean {
  if (isAbortError(err) || isTimeoutError(err)) return false;
  const status = errorStatus(err);
  if (status === undefined || status === 0) return true;
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  if (TARGET_CAUSED_4XX.has(status)) return true;
  return status < 400;
}
