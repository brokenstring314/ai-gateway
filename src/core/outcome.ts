/**
 * Classification of an upstream attempt's outcome for circuit-breaker
 * accounting, plus helpers telling the gateway's own request timeout apart
 * from a client disconnect.
 */

/** Name of the DOMException used as the abort reason for request timeouts. */
export const TIMEOUT_ERROR_NAME = "TimeoutError";

/** Abort reason the request-timeout middleware passes to controller.abort(). */
export function createTimeoutReason(timeoutMs?: number): DOMException {
  const suffix = timeoutMs !== undefined ? ` after ${timeoutMs}ms` : "";
  return new DOMException(`Request timed out${suffix}`, TIMEOUT_ERROR_NAME);
}

export function isAbortError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}

export function isTimeoutError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === TIMEOUT_ERROR_NAME;
}

/** True when `signal` was aborted by the gateway's request timeout (not by the client). */
export function isTimeoutAbort(signal: AbortSignal | undefined | null): boolean {
  return !!signal?.aborted && isTimeoutError(signal.reason);
}

/** HTTP status of an upstream error, unwrapping retry/fallback wrappers. */
export function errorStatus(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur !== null && typeof cur === "object"; depth++) {
    if ("statusCode" in cur) {
      const status = (cur as { statusCode: unknown }).statusCode;
      return typeof status === "number" ? status : undefined;
    }
    const name = (cur as { name?: unknown }).name;
    if ((name === "RetryExhaustedError" || name === "FallbackExhaustedError") && "cause" in cur) {
      cur = (cur as { cause: unknown }).cause;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The JavaScript engine's own error types: thrown by gateway code, never by an upstream. */
const LOCAL_ERROR_TYPES: readonly (abstract new (...args: never[]) => Error)[] = [
  RangeError,
  TypeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
];

/**
 * Whether `err` is a bug / resource error raised by the gateway itself (a
 * stack overflow serializing a deeply nested body, a TypeError), not
 * something the upstream did (red team 2026-11-05 D5). Upstream and
 * transport failures always arrive as errors carrying a status
 * (ProviderError; status 0 = transport), so a bare engine error says nothing
 * about the target: it must not count toward the breaker and must not fail
 * over (every target would hit the same local error).
 */
export function isLocalError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  if ("statusCode" in err) return false;
  return LOCAL_ERROR_TYPES.some((T) => err instanceof T);
}

// ── Content moderation (final red team 2026-11-06 FQ-3) ──

/** Statuses an upstream refuses a request's CONTENT with (OpenRouter moderation: 403; legal blocks: 451). */
const CONTENT_FILTER_STATUSES: ReadonlySet<number> = new Set([403, 451]);

/**
 * Markers of a refusal for the request's content in an upstream error body:
 * OpenRouter "your input was flagged" / "requires moderation", OpenAI
 * content / safety policy, Azure content_filter, DeepSeek "Content Exists
 * Risk", DashScope DataInspectionFailed, and their Chinese equivalents.
 */
const CONTENT_MARKERS =
  /flagged|moderation|content[\s_-]?(?:policy|filter|management|risk|safety)|content exists risk|safety[\s_-]?(?:system|policy|filter)|usage polic|inappropriate|data[\s_-]?inspection|sensitive[\s_-]?(?:content|word)|敏感|违规|不当内容|内容安全|内容审核|审核未通过/i;

/**
 * Markers of a credential / account / permission problem: these 403s stay
 * target failures (breaker, failover) even if the text also mentions a
 * policy, e.g. "your account was flagged".
 */
const CREDENTIAL_MARKERS =
  /api[\s_-]?key|invalid[\s_-]?(?:key|token)|unauthori[sz]ed|authenticat|permission[\s_-]?denied|not (?:allowed|authorized|permitted) to (?:access|use)|unsupported[\s_-]?(?:country|region)|region|country|account|organi[sz]ation|billing|credit|balance|quota|subscription|whitelist|ip address|forbidden ip/i;

interface UpstreamFailure {
  readonly statusCode: number;
  readonly origin?: unknown;
  readonly detail?: unknown;
  readonly upstream?: Readonly<Record<string, unknown>>;
}

/** The upstream HTTP failure inside `err` (unwrapping retry / fallback wrappers), or undefined. */
function upstreamFailureOf(err: unknown): UpstreamFailure | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur !== null && typeof cur === "object"; depth++) {
    if ("statusCode" in cur) {
      const f = cur as UpstreamFailure;
      if (typeof f.statusCode !== "number") return undefined;
      // A ProviderError says where it came from; only an upstream response can be a moderation refusal.
      if ("origin" in cur && f.origin !== "upstream") return undefined;
      return f;
    }
    const name = (cur as { name?: unknown }).name;
    if ((name === "RetryExhaustedError" || name === "FallbackExhaustedError") && "cause" in cur) {
      cur = (cur as { cause: unknown }).cause;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** OpenRouter's moderation metadata: { reasons: [...], flagged_input: "..." }. */
function moderationReasons(upstream: Readonly<Record<string, unknown>> | undefined): string[] {
  const meta = upstream?.["metadata"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return [];
  const reasons = (meta as Record<string, unknown>)["reasons"];
  return Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [];
}

function hasFlaggedInput(upstream: Readonly<Record<string, unknown>> | undefined): boolean {
  const meta = upstream?.["metadata"];
  return meta !== null && typeof meta === "object" && !Array.isArray(meta) && "flagged_input" in meta;
}

/**
 * Whether an upstream 403 / 451 refused the request for its CONTENT
 * (moderation, content / safety policy) rather than for the operator's
 * credential (FQ-3). Such a refusal is the caller's: it must not count toward
 * the circuit breaker, must not fail over (every channel would see the same
 * content) and must not disable the channel key — otherwise one tenant can
 * open the circuit for everyone with three flagged prompts. Detected from the
 * error body (message, code, type, OpenRouter metadata.reasons /
 * flagged_input); a body that also names a credential, account or region
 * problem stays a target failure.
 */
export function isContentFilteredError(err: unknown): boolean {
  const f = upstreamFailureOf(err);
  if (!f || !CONTENT_FILTER_STATUSES.has(f.statusCode)) return false;
  const up = f.upstream;
  const text = [textOf(up?.["message"]), textOf(up?.["code"]), textOf(up?.["type"]), textOf(f.detail)].join(" \n ");
  if (CREDENTIAL_MARKERS.test(text)) return false;
  return CONTENT_MARKERS.test(text) || moderationReasons(up).length > 0 || hasFlaggedInput(up);
}

/** `s` with C0 / DEL / C1 control characters replaced by spaces. */
function withoutControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? " " : ch;
  }
  return out;
}

/** Longest upstream moderation message passed on to the client. */
const CONTENT_FILTER_MESSAGE_MAX = 300;

/**
 * The client-facing message of a content_filtered error: the upstream's own
 * message, sanitized — control characters removed, URLs and token-like
 * strings masked, at most CONTENT_FILTER_MESSAGE_MAX characters — plus
 * OpenRouter's moderation reasons. Never the flagged input itself.
 */
export function contentFilteredMessage(err: unknown): string {
  const f = upstreamFailureOf(err);
  const raw = textOf(f?.upstream?.["message"]) || textOf(f?.detail);
  let msg = withoutControlChars(raw)
    .replace(/\bhttps?:\/\/\S+/gi, "[url]")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (msg.length > CONTENT_FILTER_MESSAGE_MAX) msg = `${msg.slice(0, CONTENT_FILTER_MESSAGE_MAX - 1)}…`;
  const reasons = moderationReasons(f?.upstream)
    .map((r) => r.replace(/[^\w .,/-]/g, "").slice(0, 40))
    .filter((r) => r !== "")
    .slice(0, 8);
  const head = "The upstream refused this request's content (content moderation)";
  return `${head}${msg ? `: ${msg}` : "."}${reasons.length > 0 ? ` Reasons: ${reasons.join(", ")}.` : ""}`;
}

/**
 * Upstream statuses caused by the TARGET rather than the caller's request:
 * 401/403 = the operator's credential for that target is revoked, expired or
 * not entitled (account / region blocked); 404 = the model or deployment
 * does not exist at that target. Another target may well serve the request.
 */
const TARGET_CAUSED_4XX: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * Whether an upstream error reflects target health and should count as a
 * breaker failure. Transport errors (status 0 / non-HTTP errors), 5xx, 408
 * and target credential/permission errors (401, 403) count: a target
 * with a revoked key keeps failing until an operator fixes it, so it must
 * be routed around. 404 does not count: it is usually model-specific (one
 * model missing at that target), so it must not take the target down for
 * every other model. Other 4xx (400, 409, 413, 422, ...) are caused by the
 * caller's request and must not let one tenant open the circuit for everyone;
 * so is 429 (review 2026-11-02 RB5): any client can push a shared upstream
 * key into its rate limit, and the key pool's soft cooldown handles it.
 */
export function isBreakerFailure(err: unknown): boolean {
  if (isLocalError(err)) return false;
  // A content-moderation refusal is the caller's (FQ-3), whatever its status.
  if (isContentFilteredError(err)) return false;
  if (err !== null && typeof err === "object" && "statusCode" in err) {
    const status = (err as { statusCode: unknown }).statusCode;
    if (typeof status !== "number" || status === 0) return true;
    if (status >= 500) return true;
    // 429 is not a target failure (RB5): any client can drive a shared key
    // into an upstream rate limit, which must not open the breaker for all.
    if (status === 408) return true;
    if (status === 401 || status === 403) return true;
    return status < 400; // unexpected 1xx-3xx surfaced as an error: count it
  }
  return true;
}

/**
 * Whether a failed attempt on one target should move on to the next
 * candidate target (fallback chains and every multi-target strategy).
 *
 *  - client abort / gateway request timeout: no (the request is over);
 *  - circuit open / local concurrency limit (no status): yes, skip the target;
 *  - transport errors, 5xx, 408, 429: yes;
 *  - 401 / 403 / 404 (target-caused, see TARGET_CAUSED_4XX): yes, except a
 *    403 / 451 content-moderation refusal (isContentFilteredError): no;
 *  - 402: yes (another channel bills another account; review 2026-11-02 C7),
 *    but it is never a breaker failure (isBreakerFailure) and, when no
 *    candidate is left, the client gets the 402;
 *  - other 4xx (400, 409, 413, 422, ...): no, the caller's request is the
 *    problem and every target would reject it the same way.
 *
 * RetryExhaustedError / FallbackExhaustedError are classified by their cause.
 */
export function isFailoverEligible(err: unknown): boolean {
  if (isAbortError(err) || isTimeoutError(err)) return false;
  if (isLocalError(err)) return false;
  // Every channel would refuse the same content (FQ-3).
  if (isContentFilteredError(err)) return false;
  const status = errorStatus(err);
  if (status === undefined || status === 0) return true;
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  if (TARGET_CAUSED_4XX.has(status) || status === 402) return true;
  return status < 400;
}

// ── Attempt classification (plan §1.4) ──

/** How an attempt settles its circuit-breaker permit. */
export type BreakerSettlement = "success" | "failure" | "release";

export interface AttemptFacts {
  /** The request's abort signal (client disconnect ∪ gateway deadline). */
  readonly signal?: AbortSignal | null;
  /**
   * The local concurrency limiter let the attempt through, i.e. it really
   * reached (or was about to reach) the upstream. A request that timed out
   * or was rejected while still queued never touched the upstream (C3-3).
   */
  readonly admitted: boolean;
  /** At least one stream chunk was delivered. */
  readonly started?: boolean;
  /**
   * The target's breaker counts gateway request timeouts as failures
   * (circuitBreaker.countTimeouts). Default false: a timeout releases the
   * permit (review 2026-11-05 D4).
   */
  readonly countTimeouts?: boolean;
}

export interface AttemptClassification {
  readonly breaker: BreakerSettlement;
  /** The gateway deadline fired before any output: surface a gateway timeout. */
  readonly timedOut: boolean;
}

/**
 * The single source of truth for settling a failed attempt (plan §1.4):
 *  - not admitted (breaker open, queue full, aborted / timed out while queued): release;
 *  - gateway deadline before output: reported as a timeout; release by default
 *    (the caller controls how long a request runs: a few slow requests from
 *    one key must not open the circuit for everyone, review 2026-11-05 D4),
 *    failure only when the breaker sets countTimeouts;
 *  - gateway deadline after output started: release (says little about upstream health);
 *  - client abort: success if output had started, else release;
 *  - caller-caused 4xx, upstream 404 and 429: release (see isBreakerFailure);
 *  - a local engine error (RangeError, TypeError …, see isLocalError): release;
 *  - a content-moderation 403 / 451 (isContentFilteredError): release;
 *  - anything else (network, 5xx, 408, 401/403, broken stream): failure.
 * Failover eligibility is decided separately by isFailoverEligible().
 */
export function classifyAttemptError(err: unknown, facts: AttemptFacts): AttemptClassification {
  const started = facts.started === true;
  if (!facts.admitted) return { breaker: "release", timedOut: false };
  if (isTimeoutAbort(facts.signal)) {
    if (started) return { breaker: "release", timedOut: false };
    return { breaker: facts.countTimeouts === true ? "failure" : "release", timedOut: true };
  }
  if (isAbortError(err) || facts.signal?.aborted) {
    return { breaker: started ? "success" : "release", timedOut: false };
  }
  if (!isBreakerFailure(err)) return { breaker: "release", timedOut: false };
  return { breaker: "failure", timedOut: false };
}
