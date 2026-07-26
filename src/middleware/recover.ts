/**
 * Recover middleware — catches unhandled errors and returns 500.
 * Prevents stack traces from leaking to clients.
 */

import type { MiddlewareHandler } from "hono";

export function recoverMiddleware(): MiddlewareHandler {
  return async function recover(c, next) {
    try {
      await next();
    } catch (err) {
      console.error("[gateway] unhandled error:", err);

      return c.json(
        {
          error: {
            message: "Internal server error",
            type: "internal_error",
            code: "unhandled_exception",
          },
        },
        500,
      );
    }
  };
}
