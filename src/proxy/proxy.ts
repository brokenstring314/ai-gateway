/**
 * OpenAI-compatible pass-through proxy for unhandled /v1/* routes.
 *
 * Mirrors the Go original (internal/proxy/proxy.go):
 *   - provider resolution: X-Provider header first, then the top-level
 *     "model" field in the JSON request body (nested "model" fields are
 *     ignored); neither resolves → OpenAI-shaped 400
 *   - a trailing /v1 is stripped from the target base URL so the inbound
 *     /v1 prefix is not doubled upstream
 *   - the target provider's auth headers are injected; gateway credentials
 *     (Authorization, X-Admin-Secret, X-Provider) are never forwarded
 *   - upstream status/headers/body are passed through verbatim, including
 *     streaming ReadableStream bodies
 *   - upstream transport failures become stable OpenAI error JSON (502)
 *     without leaking internal error text
 *
 * Proxy-route auth (proxyAuthMiddleware / createProxyHandler) follows the Go
 * convention: auth is required by default, ALLOW_UNAUTHENTICATED_PROXY opens
 * /v1/* only outside production, and production ignores the flag entirely.
 */

import type { Context, Handler, MiddlewareHandler } from "hono";
import type { TargetConfig } from "@/config/types";
import type { KeyStore } from "@/persistence/key-store";
import { timingSafeEqual } from "@/auth/key-hash";

// ── Types ──

export interface ProxyTarget {
  name: string;
  provider: string;
  /** Base URL with a trailing /v1 stripped (or none present). */
  baseURL: string;
  apiKey: string;
  /** Headers injected into the upstream request (usually Authorization). */
  authHeaders: Record<string, string>;
}

/** Resolves a proxy target by provider name or by body model. */
export type TargetResolver = (
  selector: { provider: string } | { model: string },
) => ProxyTarget | undefined;

export type ProviderResolution =
  | { ok: true; provider: string; target: ProxyTarget }
  | {
      ok: false;
      reason: "no_provider" | "unknown_provider" | "unknown_model";
      provider?: string;
      model?: string;
    };

export interface ResolveProxyTargetOptions {
  /** Override the default Authorization: Bearer <apiKey> convention. */
  authHeaders?: (target: TargetConfig) => Record<string, string>;
}

export interface ProxyAuthOptions {
  /** "production" disables unauthenticated proxy access unconditionally. */
  environment?: string;
  /** Dev-only escape hatch; ignored when environment === "production". */
  allowUnauthenticatedProxy?: boolean;
  keyStore?: KeyStore;
  validateKey?: (token: string) => boolean;
}

export interface ProxyHandlerOptions extends ProxyAuthOptions {
  resolveTarget: TargetResolver;
  fetchImpl?: typeof fetch;
  /**
   * Called after proxy auth and after the body is read, before anything is
   * forwarded. Returning a Response short-circuits the proxy with it (e.g. a
   * plugin rejection); returning undefined continues.
   */
  beforeForward?: (c: Context, bodyText: string | undefined) => Promise<Response | undefined>;
}

/** Minimal Hono env needed by the proxy handler (timeout signal). */
export interface ProxyEnv {
  Variables: {
    abortController: AbortController;
  };
}

export type ProxyAuthResult =
  | { status: "allowed" }
  | { status: "ok" }
  | { status: "missing_authorization" }
  | { status: "invalid_authorization" }
  | { status: "invalid_api_key" };

// ── Pure helpers: base URL / path joining ──

/**
 * Strip a trailing /v1 or /v1/ from the base URL path so that an inbound
 * /v1/... request does not double the segment (…/v1 + /v1/responses).
 * A bare-host base URL (e.g. https://api.perplexity.ai) is left intact.
 * Returns the input unchanged when it is not a valid URL.
 */
export function stripTrailingV1(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    const stripped = u.pathname.replace(/\/v1\/?$/, "");
    u.pathname = stripped === "" ? "/" : stripped;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return baseURL;
  }
}

/**
 * Join a (stripped) target base URL with the inbound /v1/* path and search
 * string, avoiding double slashes at the seam.
 */
export function buildUpstreamUrl(
  baseURL: string,
  inboundPath: string,
  search = "",
): string {
  const u = new URL(stripTrailingV1(baseURL));
  const basePath = u.pathname.replace(/\/+$/, "");
  u.pathname = basePath + (inboundPath.startsWith("/") ? inboundPath : `/${inboundPath}`);
  u.search = search;
  return u.toString();
}

// ── Pure helpers: provider resolution ──

/**
 * Resolve a target from a TargetConfig. Strips the trailing /v1 from
 * baseURL and builds the default auth convention (Authorization: Bearer
 * <apiKey>); an empty apiKey produces no auth headers (e.g. Ollama).
 */
export function resolveProxyTarget(
  target: TargetConfig,
  opts?: ResolveProxyTargetOptions,
): ProxyTarget {
  const authHeaders =
    opts?.authHeaders !== undefined
      ? opts.authHeaders(target)
      : target.apiKey
        ? { Authorization: `Bearer ${target.apiKey}` }
        : {};
  return {
    name: target.name,
    provider: target.provider,
    baseURL: stripTrailingV1(target.baseURL ?? ""),
    apiKey: target.apiKey,
    authHeaders,
  };
}

/**
 * Extract the top-level "model" string from a JSON request body without
 * decoding the full document. Nested "model" fields (e.g. inside "input"
 * or "metadata") are ignored — only the top-level key counts.
 */
export function extractTopLevelModel(body: string): string | undefined {
  let i = 0;
  const n = body.length;

  const skipWhitespace = (): void => {
    while (i < n) {
      const ch = body[i];
      if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") return;
      i++;
    }
  };

  // body[i] must be the opening quote. Returns the decoded string value.
  const readJSONString = (): string | undefined => {
    i++; // opening quote
    let raw = "";
    let escaped = false;
    while (i < n) {
      const ch = body[i]!;
      if (escaped) {
        raw += "\\" + ch;
        escaped = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        i++;
        continue;
      }
      if (ch === '"') {
        i++;
        try {
          return JSON.parse(`"${raw}"`) as string;
        } catch {
          return undefined;
        }
      }
      raw += ch;
      i++;
    }
    return undefined;
  };

  const skipScalar = (): void => {
    while (i < n) {
      const ch = body[i]!;
      if (
        ch === "," || ch === "}" || ch === "]" ||
        ch === " " || ch === "\n" || ch === "\r" || ch === "\t"
      ) {
        return;
      }
      i++;
    }
  };

  const skipComposite = (open: "{" | "["): boolean => {
    const close = open === "{" ? "}" : "]";
    let depth = 1;
    i++; // consume the opening bracket
    while (i < n) {
      const ch = body[i]!;
      if (ch === '"') {
        if (readJSONString() === undefined) return false;
        continue;
      }
      if (ch === open) {
        depth++;
        i++;
        continue;
      }
      if (ch === close) {
        depth--;
        i++;
        if (depth === 0) return true;
        continue;
      }
      if (open === "{" && ch === "[") {
        if (!skipComposite("[")) return false;
        continue;
      }
      if (open === "[" && ch === "{") {
        if (!skipComposite("{")) return false;
        continue;
      }
      i++;
    }
    return false;
  };

  const skipValue = (): boolean => {
    if (i >= n) return false;
    const ch = body[i]!;
    if (ch === '"') return readJSONString() !== undefined;
    if (ch === "{" || ch === "[") return skipComposite(ch);
    skipScalar();
    return true;
  };

  skipWhitespace();
  if (body[i] !== "{") return undefined;
  i++;

  for (;;) {
    skipWhitespace();
    if (i >= n) return undefined;
    const tok = body[i]!;
    if (tok === "}") return undefined;
    if (tok !== '"') return undefined;

    const key = readJSONString();
    if (key === undefined) return undefined;
    skipWhitespace();
    if (body[i] !== ":") return undefined;
    i++;
    skipWhitespace();

    if (key === "model") {
      if (i >= n) return undefined;
      if (body[i] !== '"') return undefined;
      return readJSONString();
    }

    if (!skipValue()) return undefined;
    skipWhitespace();
    if (i >= n) return undefined;
    const sep = body[i]!;
    if (sep !== ",") return undefined;
    i++;
  }
}

/**
 * Resolve the provider for a pass-through request: X-Provider header first
 * (no body fallback when the header names an unknown provider), then the
 * top-level "model" in the JSON body. Returns a discriminated result so the
 * caller can emit a stable OpenAI error for each failure mode.
 */
export function resolveProvider(
  providerHeader: string | undefined,
  bodyText: string | undefined,
  resolver: TargetResolver,
): ProviderResolution {
  const headerName = providerHeader !== undefined ? providerHeader.trim() : undefined;
  if (headerName !== undefined && headerName !== "") {
    const target = resolver({ provider: headerName });
    if (target !== undefined) return { ok: true, provider: headerName, target };
    return { ok: false, reason: "unknown_provider", provider: headerName };
  }

  const model =
    bodyText !== undefined && bodyText !== "" ? extractTopLevelModel(bodyText) : undefined;
  if (model !== undefined && model !== "") {
    const target = resolver({ model });
    if (target !== undefined) return { ok: true, provider: target.provider, target };
    return { ok: false, reason: "unknown_model", model };
  }

  return { ok: false, reason: "no_provider" };
}

// ── Pure helpers: header forwarding ──

/** Internal routing / hop-by-hop / credential headers never forwarded upstream. */
const INTERNAL_REQUEST_HEADERS = new Set([
  "authorization",
  "x-provider",
  "x-admin-secret",
  "x-gateway-provider",
  "host",
  "content-length",
  "expect",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const HOP_BY_HOP_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Copy the incoming request headers minus internal routing / credential /
 * hop-by-hop headers, then apply the target's auth headers. The gateway's own
 * Authorization (client API key) and X-Admin-Secret never reach the upstream.
 */
export function buildForwardHeaders(
  incoming: Headers,
  target: ProxyTarget,
): Headers {
  const out = new Headers();
  for (const [name, value] of incoming) {
    if (INTERNAL_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out.set(name, value);
  }
  for (const [name, value] of Object.entries(target.authHeaders)) {
    out.set(name, value);
  }
  return out;
}

// ── Proxy-route auth ──

/**
 * Whether unauthenticated proxy access is permitted. Production always
 * requires auth — even when allowUnauthenticatedProxy is explicitly set
 * (mirrors the Go bootstrap guard that refuses the combination at startup).
 */
export function isProxyAuthAllowed(
  opts: Pick<ProxyAuthOptions, "environment" | "allowUnauthenticatedProxy">,
): boolean {
  if (opts.environment === "production") return false;
  return opts.allowUnauthenticatedProxy === true;
}

/**
 * Build a Bearer-token validator that compares candidates with
 * timingSafeEqual — never plaintext === early exits.
 */
export function createProxyKeyValidator(
  keys: readonly string[],
): (token: string) => boolean {
  return (token: string): boolean => {
    if (token === "") return false;
    for (const candidate of keys) {
      if (timingSafeEqual(token, candidate)) return true;
    }
    return false;
  };
}

function extractBearerToken(header: string): string | undefined {
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

/**
 * Evaluate proxy-route auth for a request. Fails closed: when auth is
 * required but no keyStore or validateKey is configured, nothing passes.
 */
export function evaluateProxyAuth(
  c: Context,
  opts: ProxyAuthOptions,
): ProxyAuthResult {
  if (isProxyAuthAllowed(opts)) return { status: "allowed" };

  const header = c.req.header("Authorization");
  if (header === undefined) return { status: "missing_authorization" };

  const token = extractBearerToken(header);
  if (token === undefined) return { status: "invalid_authorization" };

  if (opts.keyStore !== undefined) {
    return opts.keyStore.validateKey(token) !== null
      ? { status: "ok" }
      : { status: "invalid_api_key" };
  }
  if (opts.validateKey !== undefined) {
    return opts.validateKey(token) ? { status: "ok" } : { status: "invalid_api_key" };
  }
  return { status: "invalid_api_key" };
}

/** Middleware gate for /v1/* proxy routes (wire with app.use("/v1/*", ...)). */
export function proxyAuthMiddleware(opts: ProxyAuthOptions): MiddlewareHandler {
  return async function proxyAuth(c, next) {
    const result = evaluateProxyAuth(c, opts);
    if (result.status === "allowed" || result.status === "ok") {
      await next();
      return;
    }
    return authFailureResponse(result.status);
  };
}

// ── Pass-through handler ──

/**
 * Create the /v1/* pass-through handler. Performs proxy-route auth itself so
 * it can be used standalone; when wired behind proxyAuthMiddleware the gate
 * simply passes (both share evaluateProxyAuth).
 */
export function createProxyHandler(options: ProxyHandlerOptions): Handler<ProxyEnv> {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (c) => {
    const authenticatedApiKey = (c.get as unknown as (key: string) => unknown)("apiKey");
    const auth = authenticatedApiKey === undefined
      ? evaluateProxyAuth(c, options)
      : { status: "ok" as const };
    if (auth.status !== "allowed" && auth.status !== "ok") {
      return authFailureResponse(auth.status);
    }

    const url = new URL(c.req.url);
    if (url.pathname !== "/v1" && !url.pathname.startsWith("/v1/")) {
      return openAIErrorResponse(404, "not found", "invalid_request_error", "not_found");
    }

    // Read the body once: forwarded byte-for-byte upstream, decoded only to
    // extract a top-level "model" when no X-Provider header was given.
    const raw = await c.req.arrayBuffer();
    const bodyBuffer = raw.byteLength > 0 ? raw : undefined;
    const bodyText =
      bodyBuffer !== undefined ? new TextDecoder().decode(bodyBuffer) : undefined;

    if (options.beforeForward) {
      const blocked = await options.beforeForward(c as unknown as Context, bodyText);
      if (blocked !== undefined) return blocked;
    }

    const resolution = resolveProvider(
      c.req.header("X-Provider"),
      bodyText,
      options.resolveTarget,
    );
    if (!resolution.ok) {
      return providerErrorResponse(resolution);
    }

    const { provider, target } = resolution;

    if (target.baseURL === "") {
      return openAIErrorResponse(502, "upstream provider is unavailable", "server_error", "internal_error");
    }

    let upstreamUrl: string;
    try {
      upstreamUrl = buildUpstreamUrl(target.baseURL, url.pathname, url.search);
    } catch {
      return openAIErrorResponse(502, "upstream provider is unavailable", "server_error", "internal_error");
    }

    const headers = buildForwardHeaders(c.req.raw.headers, target);

    // Propagate the request-timeout middleware's abort, falling back to the
    // incoming request's own signal when running without the middleware.
    const abortController = (c.get as unknown as (key: string) => unknown)("abortController");
    const signal =
      abortController instanceof AbortController
        ? abortController.signal
        : c.req.raw.signal;

    let upstream: Response;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: c.req.method,
        headers,
        body: bodyBuffer,
        redirect: "manual",
        signal,
      });
    } catch {
      // Generic, stable error — never expose internal error text/stack.
      return openAIErrorResponse(502, "upstream connection failed", "server_error", "upstream_error");
    }

    // Pass the upstream response through verbatim: status, headers, body
    // (including streaming ReadableStream bodies).
    const responseHeaders = new Headers(upstream.headers);
    for (const name of HOP_BY_HOP_RESPONSE_HEADERS) {
      responseHeaders.delete(name);
    }
    responseHeaders.set("X-Gateway-Provider", provider);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  };
}

// ── Error responses ──

function openAIErrorResponse(
  status: number,
  message: string,
  type: string,
  code: string,
): Response {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providerErrorResponse(
  resolution: ProviderResolution & { ok: false },
): Response {
  if (resolution.reason === "unknown_provider") {
    return openAIErrorResponse(
      400,
      `unknown provider "${resolution.provider}"`,
      "invalid_request_error",
      "unknown_provider",
    );
  }
  if (resolution.reason === "unknown_model") {
    return openAIErrorResponse(
      400,
      `no provider found for model "${resolution.model}"`,
      "invalid_request_error",
      "model_not_found",
    );
  }
  return openAIErrorResponse(
    400,
    'no provider resolved; set the X-Provider header (e.g. "X-Provider: openai") or include a "model" field in the request body',
    "invalid_request_error",
    "provider_not_resolved",
  );
}

function authFailureResponse(status: ProxyAuthResult["status"]): Response {
  if (status === "missing_authorization") {
    return openAIErrorResponse(401, "Missing Authorization header", "authentication_error", "missing_authorization");
  }
  if (status === "invalid_authorization") {
    return openAIErrorResponse(401, "Invalid Authorization header format; expected Bearer <token>", "authentication_error", "invalid_authorization");
  }
  return openAIErrorResponse(401, "Invalid API key", "authentication_error", "invalid_api_key");
}
