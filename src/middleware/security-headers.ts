/**
 * Security headers middleware — adds standard security headers to all responses.
 */

import type { MiddlewareHandler } from "hono";

export function securityHeadersMiddleware(): MiddlewareHandler {
  return async function securityHeaders(c, next) {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-XSS-Protection", "0");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  };
}
