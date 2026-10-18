/**
 * One error model for every endpoint (refactor plan §1.3).
 *
 * Every failure a handler can see is turned into a GatewayError by
 * toGatewayError() — the only place that decides the HTTP status and the
 * OpenAI-shaped body — and rendered by errorBody()/errorHeaders()
 * (errorToResponse() for non-Hono callers, errorToSseEvent() mid-stream).
 *
 * Rules:
 *  - target names and upstream URLs never appear in the body; the target is
 *    reported in the X-Gateway-Target response header and in server logs;
 *  - an OpenAI-shaped upstream error keeps its code / type / param / message;
 *  - network failures and unparsable upstream bodies get a fixed message;
 *  - FallbackExhausted / RetryExhausted wrappers are unwrapped.
 */

import { PluginRejectionError } from "../plugins/error.js";
import { ProviderError, type UpstreamErrorBody } from "../providers/openai-compat.js";
import { ReadableStreamError, type StreamErrorCode } from "../providers/sse-parser.js";
import { CircuitOpenError } from "../routing/circuit-breaker.js";
import { ConcurrencyLimitError } from "../routing/concurrency-limiter.js";
import { isTimeoutAbort, isTimeoutError } from "./outcome.js";

export type ErrorKind =
  | "invalid_request" // 400  gateway-side validation
  | "auth" // 401/403 gateway client auth
  | "plugin_rejected" // 403, or the plugin's own status (rate-limit / budget → 429)
  | "model_not_found" // 404  no target serves this model / capability
  | "upstream_client" // upstream 4xx passed through (400/404/409/413/422 …)
  | "upstream_auth" // upstream 401/403 after failover → 502
  | "upstream_rate" // upstream 429 → 429 with Retry-After
  | "upstream_server" // upstream 5xx → 502
  | "upstream_unavailable" // network error / RST / invalid body → 502
  | "breaker_open" // every candidate's breaker OPEN → 503
  | "overloaded" // local concurrency queue full / queue timeout → 429
  | "timeout" // gateway request timeout → 504
  | "internal"; // 500

/** Header naming the target that produced (or failed) the response. */
export const TARGET_HEADER = "X-Gateway-Target";

export interface GatewayErrorInit {
  readonly status: number;
  readonly message: string;
  readonly type: string;
  readonly code?: string | null;
  readonly param?: string | null;
  readonly target?: string;
  readonly retryAfter?: string;
  readonly cause?: unknown;
}

export class GatewayError extends Error {
  override name = "GatewayError";
  readonly kind: ErrorKind;
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;
  readonly target: string | undefined;
  readonly retryAfter: string | undefined;
  override readonly cause: unknown;

  constructor(kind: ErrorKind, init: GatewayErrorInit) {
    super(init.message);
    this.kind = kind;
    this.status = init.status;
    this.type = init.type;
    this.code = init.code ?? null;
    this.param = init.param ?? null;
    this.target = init.target;
    this.retryAfter = init.retryAfter;
    this.cause = init.cause;
  }

  /** Alias of `status`, so code that reads `err.statusCode` (embedded callers, outcome helpers) keeps working. */
  get statusCode(): number {
    return this.status;
  }
}

/** OpenAI error body: `{ error: { message, type, code, param } }`. */
export interface OpenAIErrorBody {
  error: { message: string; type: string; code: string | null; param: string | null };
}

// ── Constructors for the gateway's own errors ──

export function invalidRequest(message: string, code = "invalid_request", param?: string): GatewayError {
  return new GatewayError("invalid_request", { status: 400, message, type: "invalid_request_error", code, param });
}

export function modelNotFound(message: string): GatewayError {
  return new GatewayError("model_not_found", {
    status: 404,
    message,
    type: "invalid_request_error",
    code: "model_not_found",
  });
}

export function gatewayTimeout(target?: string): GatewayError {
  return new GatewayError("timeout", {
    status: 504,
    message: "Upstream request timed out",
    type: "timeout_error",
    code: "gateway_timeout",
    target,
  });
}

export function internalError(cause?: unknown): GatewayError {
  return new GatewayError("internal", { status: 500, message: "Internal server error", type: "internal_error", cause });
}

// ── Classification ──

const WRAPPER_NAMES: ReadonlySet<string> = new Set(["FallbackExhaustedError", "RetryExhaustedError"]);

/** Strip FallbackExhausted / RetryExhausted wrappers down to the attempt error. */
export function unwrapExhausted(err: unknown): unknown {
  let cur = err;
  for (let i = 0; i < 8; i++) {
    if (cur === null || typeof cur !== "object") return cur;
    const name = (cur as { name?: unknown }).name;
    if (typeof name !== "string" || !WRAPPER_NAMES.has(name) || !("cause" in cur)) return cur;
    const next = (cur as { cause: unknown }).cause;
    if (next === undefined) return cur;
    cur = next;
  }
  return cur;
}

export interface ToGatewayErrorOptions {
  /** The request's abort signal: a TimeoutError reason means the gateway's own deadline fired. */
  readonly signal?: AbortSignal | null;
}

/** The single entry point mapping any thrown value to a GatewayError. */
export function toGatewayError(err: unknown, opts: ToGatewayErrorOptions = {}): GatewayError {
  const inner = unwrapExhausted(err);
  if (inner instanceof GatewayError) {
    // A request that hit the gateway deadline is a timeout, whatever the
    // last attempt surfaced as.
    if (inner.kind !== "timeout" && isTimeoutAbort(opts.signal) && isAttemptError(inner)) {
      return gatewayTimeout(inner.target);
    }
    return inner;
  }
  if (isTimeoutAbort(opts.signal) || isTimeoutError(inner)) {
    return gatewayTimeout(inner instanceof ProviderError ? inner.provider : undefined);
  }
  if (inner instanceof PluginRejectionError) {
    return new GatewayError("plugin_rejected", {
      status: inner.status,
      message: inner.reason,
      type: "plugin_rejection",
      code: "plugin_rejected",
      retryAfter: inner.retryAfterSeconds !== undefined ? String(inner.retryAfterSeconds) : undefined,
      cause: inner,
    });
  }
  if (inner instanceof ProviderError) return fromProviderError(inner);
  if (inner instanceof ReadableStreamError) return fromStreamError(inner);
  if (inner instanceof CircuitOpenError) {
    return new GatewayError("breaker_open", {
      status: 503,
      message: "Upstream temporarily unavailable (circuit open)",
      type: "server_error",
      code: "circuit_open",
      target: inner.target,
      retryAfter: inner.retryAfterSeconds !== undefined ? String(inner.retryAfterSeconds) : undefined,
      cause: inner,
    });
  }
  if (inner instanceof ConcurrencyLimitError) {
    return new GatewayError("overloaded", {
      status: 429,
      message: "Gateway is overloaded for this model; retry later",
      type: "rate_limit_error",
      code: "gateway_overloaded",
      target: inner.target,
      retryAfter: "1",
      cause: inner,
    });
  }
  return internalError(inner);
}

/** Errors that the gateway deadline turns into a 504 (local overload stays 429). */
function isAttemptError(e: GatewayError): boolean {
  return e.kind.startsWith("upstream_") || e.kind === "breaker_open";
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

const STREAM_ERROR_MESSAGES: Readonly<Record<StreamErrorCode, string>> = {
  upstream_stream_error: "Upstream stream failed",
  upstream_stream_truncated: "Upstream closed the stream before completion",
  upstream_empty_stream: "Upstream returned an empty stream",
  upstream_invalid_response: "Invalid response from upstream",
  upstream_event_too_large: "Upstream stream event too large",
};

/** A broken upstream stream (read failure, truncation, malformed or oversized event): 502, fixed message. */
function fromStreamError(e: ReadableStreamError): GatewayError {
  return new GatewayError("upstream_unavailable", {
    status: 502,
    message: STREAM_ERROR_MESSAGES[e.code] ?? STREAM_ERROR_MESSAGES.upstream_stream_error,
    type: "server_error",
    code: e.code,
    cause: e,
  });
}

function fromProviderError(p: ProviderError): GatewayError {
  const target = p.provider;
  const up: UpstreamErrorBody = p.upstream ?? {};
  const status = p.statusCode;

  if (p.origin === "transport" || status === 0) {
    return new GatewayError("upstream_unavailable", {
      status: 502,
      message: "Upstream service unavailable",
      type: "server_error",
      code: "upstream_unavailable",
      target,
      cause: p,
    });
  }
  if (p.origin === "invalid_body") {
    return new GatewayError("upstream_unavailable", {
      status: 502,
      message: "Invalid response from upstream",
      type: "server_error",
      code: "upstream_invalid_response",
      target,
      cause: p,
    });
  }
  if (p.origin === "local") {
    // Raised by the gateway itself (e.g. a parameter the target cannot take
    // in compatibility mode "reject"): the status was chosen locally.
    if (status === 504) return gatewayTimeout(target);
    const kind: ErrorKind = status >= 400 && status < 500 ? "invalid_request" : "upstream_server";
    return new GatewayError(kind, {
      status: status >= 400 && status < 600 ? status : 502,
      message: p.detail,
      type: kind === "invalid_request" ? "invalid_request_error" : "server_error",
      code: kind === "invalid_request" ? "unsupported_parameter" : "upstream_error",
      target,
      cause: p,
    });
  }

  // origin "upstream": an HTTP error response (or an SSE error event) from the target.
  if (status === 401 || status === 403) {
    return new GatewayError("upstream_auth", {
      status: 502,
      message: "Upstream authentication failed",
      type: "server_error",
      code: "upstream_auth_failed",
      target,
      cause: p,
    });
  }
  if (status === 429) {
    return new GatewayError("upstream_rate", {
      status: 429,
      message: str(up.message) ?? "Upstream rate limit exceeded",
      type: str(up.type) ?? "rate_limit_error",
      code: str(up.code) ?? "rate_limit_exceeded",
      param: str(up.param),
      target,
      retryAfter: p.retryAfter,
      cause: p,
    });
  }
  if (status === 408) return gatewayTimeout(target);
  if (status >= 400 && status < 500) {
    return new GatewayError("upstream_client", {
      status,
      message: str(up.message) ?? p.detail,
      type: str(up.type) ?? "invalid_request_error",
      code: str(up.code),
      param: str(up.param),
      target,
      cause: p,
    });
  }
  return new GatewayError("upstream_server", {
    status: 502,
    message: str(up.message) ?? "Upstream server error",
    type: str(up.type) ?? "server_error",
    code: str(up.code) ?? "upstream_error",
    param: str(up.param),
    target,
    retryAfter: p.retryAfter,
    cause: p,
  });
}

/**
 * When several attempts failed, the one reported to the client
 * (plan §1.3): upstream_client > upstream_rate > upstream_auth > timeout >
 * upstream_server > upstream_unavailable > overloaded > breaker_open.
 * Ties keep the latest attempt.
 */
const PRIORITY: Readonly<Partial<Record<ErrorKind, number>>> = {
  upstream_client: 8,
  upstream_rate: 7,
  upstream_auth: 6,
  timeout: 5,
  upstream_server: 4,
  upstream_unavailable: 3,
  overloaded: 2,
  breaker_open: 1,
};

export function mostMeaningful(errors: readonly unknown[]): unknown {
  let best: unknown;
  let bestRank = -1;
  for (const err of errors) {
    const rank = PRIORITY[toGatewayError(err).kind] ?? 0;
    if (rank >= bestRank) {
      best = err;
      bestRank = rank;
    }
  }
  return best;
}

// ── Rendering ──

export function errorBody(e: GatewayError): OpenAIErrorBody {
  return { error: { message: e.message, type: e.type, code: e.code, param: e.param } };
}

export function errorHeaders(e: GatewayError): Record<string, string> {
  const h: Record<string, string> = {};
  if (e.target) h[TARGET_HEADER] = e.target;
  if (e.retryAfter) h["Retry-After"] = e.retryAfter;
  return h;
}

export function errorToResponse(e: GatewayError): Response {
  return Response.json(errorBody(e), { status: e.status, headers: errorHeaders(e) });
}

/** SSE `data:` frame carrying the same error shape, for errors after the stream started. */
export function errorToSseEvent(e: GatewayError): string {
  return `data: ${JSON.stringify(errorBody(e))}\n\n`;
}

/** Log line for a failed request: the full detail (target, upstream message) stays server-side. */
export function logGatewayError(e: GatewayError, label = "gateway"): void {
  if (e.kind === "plugin_rejected" || e.kind === "invalid_request") return;
  const cause = e.cause instanceof Error ? e.cause.message : e.cause !== undefined ? String(e.cause) : "";
  console.error(
    `[${label}] ${e.status} ${e.kind}${e.target ? ` target=${e.target}` : ""}: ${e.message}${cause && cause !== e.message ? ` (${cause})` : ""}`,
  );
}
