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

/**
 * True for the admin surface (`/admin`, `/admin/…`), matched loosely (case,
 * repeated slashes, percent-encoding) so no spelling of it gets CORS headers.
 */
export function isAdminPath(path: string): boolean {
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  return /^\/+admin(?:\/|$)/i.test(p);
}

/**
 * CORS for the API. Never for `/admin/*` (final red team 2026-11-06 FA-1):
 * the console is same-origin, and allowing `X-Admin-Secret` / `Authorization`
 * from every origin let any web page send credential guesses that locked the
 * admin's IP out. An admin preflight is answered 204 without any
 * Access-Control-* header, so the browser never sends the real request.
 */
export function corsMiddleware(origins?: string[], options: CorsOptions = {}): MiddlewareHandler {
  const api = apiCors(origins, options);
  return async (c, next) => {
    if (isAdminPath(c.req.path) || isAdminPath(new URL(c.req.url).pathname)) {
      if (c.req.method === "OPTIONS" && c.req.header("Access-Control-Request-Method") !== undefined) {
        return c.body(null, 204);
      }
      return next();
    }
    return api(c, next);
  };
}

function apiCors(origins: string[] | undefined, options: CorsOptions): MiddlewareHandler {
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
