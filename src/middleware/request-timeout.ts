/**
 * Request timeout middleware — sets an AbortController with a configurable timeout.
 * The duration is parsed by the shared config parser (config/duration.ts):
 * "500ms", "30s", "5m", "1m30s"; an invalid string throws at construction.
 */

import type { MiddlewareHandler } from "hono";
import { parseDurationOrThrow } from "../config/duration.js";
import { createTimeoutReason } from "../core/outcome.js";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

export function requestTimeoutMiddleware(timeout?: string): MiddlewareHandler {
  const timeoutMs = timeout ? parseDurationOrThrow("requestTimeout", timeout) : DEFAULT_TIMEOUT_MS;

  return async function requestTimeout(c, next) {
    const controller = new AbortController();
    c.set("abortController", controller);

    const timer = setTimeout(() => {
      // A TimeoutError reason lets downstream code tell the gateway's own
      // timeout (upstream too slow -> breaker failure, HTTP 504) apart from a
      // client disconnect (not an upstream failure).
      controller.abort(createTimeoutReason(timeoutMs));
    }, timeoutMs);

    try {
      await next();
    } finally {
      clearTimeout(timer);
    }
  };
}
