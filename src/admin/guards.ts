/**
 * Guards shared by the Admin API write endpoints (0.3.0 P4).
 *
 * CSRF (plan §9.4): Admin API credentials travel only in headers
 * (Authorization: Bearer / X-Admin-Secret), which a browser never attaches
 * on its own, so a cross-site page cannot forge an authenticated write. As
 * defence in depth every state-changing /admin request must additionally
 *  - not come from another site (Sec-Fetch-Site: cross-site is refused; an
 *    Origin header must be this server's origin or a configured CORS
 *    origin), and
 *  - carry no body or a JSON body (Content-Type: application/json): HTML
 *    forms and other "simple" cross-site requests are refused.
 * The console's cookie session (P6) adds a double-submit CSRF token on top.
 */

import type { Context, MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function adminError(
  c: Context,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  const type =
    status === 400 || status === 422
      ? "invalid_request_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "authorization_error"
          : status === 404
            ? "not_found"
            : status === 409 || status === 412 || status === 428
              ? "conflict"
              : status === 429
                ? "rate_limit_error"
                : "server_error";
  return c.json({ error: { message, type, code, ...extra } }, status as never);
}

export function csrfGuard(opts: { allowedOrigins?: () => readonly string[] | undefined } = {}): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const site = c.req.header("Sec-Fetch-Site");
    if (site !== undefined && site.toLowerCase() === "cross-site") {
      return adminError(c, 403, "csrf_rejected", "Cross-site requests to the Admin API are not allowed");
    }
    const origin = c.req.header("Origin");
    if (origin !== undefined && origin !== "") {
      const self = new URL(c.req.url).origin;
      const allowed = opts.allowedOrigins?.() ?? [];
      if (origin !== self && !allowed.includes(origin) && !allowed.includes("*")) {
        return adminError(
          c,
          403,
          "csrf_rejected",
          `Requests from origin ${origin} are not allowed to change the gateway`,
        );
      }
    }
    const type = c.req.header("Content-Type");
    if (type !== undefined && type !== "" && !/^application\/json\s*(;|$)/i.test(type)) {
      return adminError(c, 415, "unsupported_media_type", "Admin API writes take Content-Type: application/json");
    }
    return next();
  };
}

/** Parse If-Match: `"12"`, `W/"12"` or `12`. Undefined when absent; NaN when malformed. */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === "") return undefined;
  const m = header.trim().match(/^(?:W\/)?"?(\d{1,15})"?$/);
  return m ? Number(m[1]) : Number.NaN;
}

/** ETag header value for a revision. */
export function etag(revision: number): string {
  return `"${revision}"`;
}

/** Fixed-window limiter: `limit` calls per `windowMs` per key. */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait when over the limit, else undefined (and the call is counted). */
  take(key: string): number | undefined {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.windows.clear();
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    w.count++;
    return undefined;
  }
}

/** Who made an admin request, for the audit log (never the credential itself). */
export function actorOf(c: Context): string {
  const v = (c.get as unknown as (k: string) => unknown)("actor");
  return typeof v === "string" && v !== "" ? v : "admin";
}
