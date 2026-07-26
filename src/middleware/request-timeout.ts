/**
 * Request timeout middleware — sets an AbortController with a configurable timeout.
 * Parses Go-style duration strings (e.g. "30s", "5m", "1m30s").
 */

import type { MiddlewareHandler } from "hono";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

/** Parse a Go-style duration string into milliseconds. Supports s, m, h suffixes. */
export function parseGoDuration(d: string): number {
  let totalMs = 0;
  const pattern = /(\d+)([smh])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(d)) !== null) {
    const value = Number(match[1]);
    const unit = match[2];
    switch (unit) {
      case "s":
        totalMs += value * 1000;
        break;
      case "m":
        totalMs += value * 60 * 1000;
        break;
      case "h":
        totalMs += value * 60 * 60 * 1000;
        break;
    }
  }
  return totalMs;
}

export function requestTimeoutMiddleware(timeout?: string): MiddlewareHandler {
  const timeoutMs = timeout ? parseGoDuration(timeout) : DEFAULT_TIMEOUT_MS;

  return async function requestTimeout(c, next) {
    const controller = new AbortController();
    c.set("abortController", controller);

    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      await next();
    } finally {
      clearTimeout(timer);
    }
  };
}
