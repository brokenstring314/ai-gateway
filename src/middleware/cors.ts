/**
 * CORS middleware — wraps Hono's built-in cors() with config-driven options.
 *
 * `allowHeaders`: when unset or empty, the preflight reflects the browser's
 * `Access-Control-Request-Headers` (so SDK headers such as `x-stainless-*`,
 * `openai-organization`, `openai-project`, `openai-beta` pass). Set an explicit
 * list in config (`cors.allowHeaders`) to restrict it.
 */

import { cors as honoCors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

export interface CorsOptions {
  /** Explicit Access-Control-Allow-Headers. Empty/unset = reflect the request's headers. */
  allowHeaders?: string[];
}

export function corsMiddleware(origins?: string[], options: CorsOptions = {}): MiddlewareHandler {
  const origin = origins && origins.length > 0 ? origins.join(",") : "*";

  return honoCors({
    origin,
    allowMethods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH"],
    // [] makes hono reflect Access-Control-Request-Headers (and add Vary).
    allowHeaders: options.allowHeaders ?? [],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 86400,
  });
}
