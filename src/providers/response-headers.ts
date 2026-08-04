/**
 * Upstream response-header forwarding for non-proxy handler paths.
 *
 * Providers publish a small whitelist of useful upstream HTTP response
 * headers (rate-limit counters, upstream request id, Retry-After) on the
 * response / request context, and handlers copy them onto the client
 * response. Only the fixed whitelist below is ever forwarded — hop-by-hop
 * and credential headers are never included, even if a provider misbehaves.
 */

/** Fixed whitelist of upstream response headers forwarded to clients. */
export const FORWARDABLE_UPSTREAM_HEADERS: readonly string[] = [
  "x-ratelimit-remaining",
  "x-ratelimit-limit",
  "x-ratelimit-reset",
  "x-request-id",
  "retry-after",
];

/** Hop-by-hop headers that must never be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const FORWARDABLE_HEADER_SET: ReadonlySet<string> = new Set(
  FORWARDABLE_UPSTREAM_HEADERS,
);

/**
 * Extract the forwardable headers from an upstream `Headers` object.
 * Keys are normalised to lowercase; hop-by-hop headers and anything outside
 * the fixed whitelist are skipped. Returns `undefined` when no whitelisted
 * header is present.
 */
export function extractForwardableHeaders(
  headers: Headers,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue;
    if (!FORWARDABLE_HEADER_SET.has(lower)) continue;
    out[lower] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge forwardable upstream headers onto the handler's response headers.
 * Only the fixed whitelist is ever copied, so stray keys in `upstream` are
 * ignored even if a provider populated it incorrectly.
 */
export function mergeForwardedHeaders(
  target: Record<string, string>,
  upstream: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (upstream === undefined) return target;
  const merged: Record<string, string> = { ...target };
  for (const name of FORWARDABLE_UPSTREAM_HEADERS) {
    const value = upstream[name];
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}
