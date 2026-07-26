/**
 * CORS middleware — wraps Hono's built-in cors() with config-driven options.
 */

import { cors as honoCors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

export function corsMiddleware(origins?: string[]): MiddlewareHandler {
  const origin = origins && origins.length > 0
    ? origins.join(",")
    : "*";

  return honoCors({
    origin,
    allowMethods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH"],
    allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 86400,
  });
}
