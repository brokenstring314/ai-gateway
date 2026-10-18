/**
 * Pass-through proxy surface (plan 2.8, S3-6).
 *
 * Pure helpers, no I/O:
 *  - the method+path allow-list for `/v1/*` routes the gateway does not own
 *    (default: stateless POST endpoints only, so one tenant can never list,
 *    read or delete the upstream account's stored objects — files, stored
 *    completions, responses, batches, vector stores — with the operator key);
 *  - the methods of gateway-owned routes (any other method → 405);
 *  - mapping a proxied body's token limit (`max_output_tokens` /
 *    `max_tokens` / `max_completion_tokens`) into the plugin view and writing
 *    a capped value back, so the max-token plugin applies to proxied bodies.
 */

/** Routes forwarded when `passthroughProxy.routes` is not configured. */
export const DEFAULT_PASSTHROUGH_ROUTES: readonly string[] = [
  "POST /v1/responses",
  "POST /v1/moderations",
  "POST /v1/audio/*",
];

/** Allowed methods of the gateway's own /v1 routes (see server/route-path.ts). */
export const GATEWAY_ROUTE_METHODS: Readonly<Record<string, readonly string[]>> = {
  "/v1/chat/completions": ["POST"],
  "/v1/completions": ["POST"],
  "/v1/embeddings": ["POST"],
  "/v1/images/generations": ["POST"],
  "/v1/models": ["GET", "HEAD"],
  "/v1/capabilities": ["GET", "HEAD"],
};

/** `METHOD /v1/path`, path optionally ending in `/*` (any sub-path, at least one segment). */
export const PASSTHROUGH_ROUTE_PATTERN = /^(GET|POST|PUT|PATCH|DELETE|\*) (\/v1(?:\/[A-Za-z0-9._~:@!$&'()+,;=-]+)*)(\/\*)?$/;

interface CompiledRoute {
  readonly method: string;
  readonly path: string;
  readonly prefix: boolean;
}

export type RouteAllowlist = (method: string, path: string) => boolean;

/** Compile allow-list entries ("POST /v1/responses", "POST /v1/audio/*"). Throws on a malformed entry. */
export function compileRouteAllowlist(routes: readonly string[] = DEFAULT_PASSTHROUGH_ROUTES): RouteAllowlist {
  const compiled: CompiledRoute[] = routes.map((entry) => {
    const m = PASSTHROUGH_ROUTE_PATTERN.exec(entry.trim());
    if (!m) throw new Error(`invalid passthroughProxy.routes entry: ${JSON.stringify(entry)} (expected "METHOD /v1/path" or "METHOD /v1/prefix/*")`);
    return { method: m[1]!, path: m[2]!, prefix: m[3] !== undefined };
  });
  return (method, path) => {
    // Encoded separators / backslashes could address a different upstream
    // path than the one checked here: never forward them.
    if (/%2f|%5c|\\/i.test(path)) return false;
    const p = path.replace(/\/{2,}/g, "/");
    const verb = method.toUpperCase();
    return compiled.some((r) =>
      (r.method === "*" || r.method === verb) &&
      (r.prefix ? p.startsWith(`${r.path}/`) && p.length > r.path.length + 1 : p === r.path));
  };
}

// ── Token limit ↔ plugin view ──

const TOKEN_FIELDS = ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const;
export type PassthroughTokenField = (typeof TOKEN_FIELDS)[number];

/**
 * Which body field carries the output token limit: the one the client sent,
 * else `max_output_tokens` for the Responses API (so a cap can be injected
 * when the client omitted it), else none (moderations, audio: no limit).
 */
export function passthroughTokenField(path: string, body: Readonly<Record<string, unknown>>): PassthroughTokenField | undefined {
  for (const f of TOKEN_FIELDS) {
    if (typeof body[f] === "number") return f;
  }
  if (path === "/v1/responses" || path.startsWith("/v1/responses/")) return "max_output_tokens";
  return undefined;
}

/** The plugin view's `maxTokens` for a proxied body (undefined when absent / not applicable). */
export function passthroughMaxTokens(body: Readonly<Record<string, unknown>>, field: PassthroughTokenField | undefined): number | undefined {
  if (field === undefined) return undefined;
  const v = body[field];
  return typeof v === "number" ? v : undefined;
}

/**
 * Write the plugin view's token limit back onto the body. Returns the new body
 * text, or undefined when nothing changed. Only lowering (or setting an
 * absent) limit is honoured; content changes are handled by the caller.
 */
export function applyPassthroughMaxTokens(
  body: Readonly<Record<string, unknown>>,
  field: PassthroughTokenField | undefined,
  viewMaxTokens: number | undefined,
): string | undefined {
  if (field === undefined || viewMaxTokens === undefined) return undefined;
  const current = body[field];
  if (typeof current === "number" && current <= viewMaxTokens) return undefined;
  return JSON.stringify({ ...body, [field]: viewMaxTokens });
}
