/**
 * Body limit middleware — rejects requests exceeding maxRequestBytes.
 * Checks Content-Length header before the body is parsed.
 */

import type { MiddlewareHandler } from "hono";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export function bodyLimitMiddleware(maxBytes?: number): MiddlewareHandler {
  const limit = maxBytes ?? DEFAULT_MAX_BYTES;

  return async function bodyLimit(c, next) {
    const contentLength = c.req.header("Content-Length");
    if (contentLength !== undefined) {
      const length = Number(contentLength);
      if (!Number.isNaN(length) && length > limit) {
        return c.json(
          {
            error: {
              message: `Request body exceeds maximum allowed size of ${limit} bytes`,
              type: "request_too_large",
              code: "request_entity_too_large",
            },
          },
          413,
        );
      }
    }
    await next();
  };
}
