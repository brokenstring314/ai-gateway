/**
 * Request-path normalization for routing.
 *
 * Without it, trivially different spellings of a real route
 * (`/v1/chat/completions/`, `/v1//chat/completions`, `/v1/Chat/Completions`,
 * `/v1/chat%2Fcompletions`) missed the dedicated handler and fell through to
 * the `/v1/*` pass-through proxy, bypassing plugins, breakers and fallback.
 *
 * Every request is routed (handlers AND middleware) on the normalized path:
 * duplicate slashes collapsed, trailing slash removed, and any spelling that
 * case-insensitively matches a gateway-owned /v1 route mapped onto it.
 */
import { getPath as honoGetPath } from "hono/utils/url";

/** /v1 routes served by dedicated gateway handlers (never proxied). */
export const GATEWAY_V1_ROUTES: readonly string[] = [
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/images/generations",
  "/v1/models",
  "/v1/capabilities",
];

export function normalizeRoutePath(path: string): string {
  let p = path.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p === "") p = "/";
  const canonical = p.replace(/%2f/gi, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const route of GATEWAY_V1_ROUTES) {
    if (canonical === route) return route;
  }
  return p;
}

/** Hono `getPath` option: Hono's default path extraction, then normalization. */
export function getNormalizedPath(request: Request): string {
  return normalizeRoutePath(honoGetPath(request));
}
