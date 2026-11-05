/**
 * Error-message redaction utilities.
 *
 * Provides privacy-aware redaction of free-form messages (`redactMessage`)
 * and arbitrary nested data (`redactObject`) with three privacy levels:
 *   - "none":     no redaction; input is returned as-is
 *   - "metadata": redact known secret patterns (emails, JWTs, API keys, ...)
 *   - "full":     no redaction; full data is allowed, input returned as-is
 *
 * Redaction never mutates its input.
 */

export type PrivacyLevel = "none" | "metadata" | "full";

// Every pattern here runs on text an attacker can shape (error messages carry
// the requested model name, upstream error bodies …), so each one must stay
// linear in the input length (red team 2026-11-05 D1: an unbounded
// `[…]+@[…]+\.[…]{2,}` email regex froze the whole event loop for 52 s on a
// 300 KB model name). The four regexes below start with a literal and their
// unbounded class run either succeeds or stops at a character outside it, so
// each start position costs O(1) amortised; emails and JWTs, whose patterns
// would backtrack over a long run for every start position, use the manual
// scanners further down.
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;
const FGW_KEY_RE = /\bfgw_[A-Za-z0-9_-]{4,}/g;
const BEARER_RE = /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]+/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;

/**
 * Redact known secret patterns from a free-form message.
 *
 * Handles multiple patterns and multiple occurrences per pattern:
 *   - email addresses          -> [REDACTED_EMAIL]
 *   - three-part "eyJ..." JWTs -> [REDACTED_JWT]
 *   - "sk-" prefixed API keys  -> [REDACTED_KEY]
 *   - "fgw_" prefixed keys     -> [REDACTED_KEY]
 *   - "Bearer <token>"         -> [REDACTED_BEARER]
 *   - "AKIA..." AWS key ids    -> [REDACTED_AWS_KEY]
 *
 * Bearer tokens are matched before JWTs/keys so a token carried inside a
 * Bearer header is replaced wholesale and never leaks a partial match.
 * Runs in time linear in `message.length`.
 *
 * @param message the raw message
 * @param level   privacy level ("none" and "full" return the input unchanged)
 */
export function redactMessage(message: string, level: PrivacyLevel = "metadata"): string {
  if (level !== "metadata") return message;

  let out = message;
  out = out.replace(BEARER_RE, "[REDACTED_BEARER]");
  out = redactJwts(out);
  out = out.replace(SK_KEY_RE, "[REDACTED_KEY]");
  out = out.replace(FGW_KEY_RE, "[REDACTED_KEY]");
  out = out.replace(AWS_KEY_RE, "[REDACTED_AWS_KEY]");
  out = redactEmails(out);
  return out;
}

// ── Linear scanners ──

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAsciiDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** `\w`: [A-Za-z0-9_] */
function isWordChar(c: number): boolean {
  return isAsciiLetter(c) || isAsciiDigit(c) || c === 95;
}

/** [A-Za-z0-9_-] (JWT segment / base64url). */
function isB64UrlChar(c: number): boolean {
  return isWordChar(c) || c === 45;
}

/** [A-Za-z0-9._%+-] (email local part). */
function isEmailLocalChar(c: number): boolean {
  return isAsciiLetter(c) || isAsciiDigit(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
}

/** [A-Za-z0-9.-] (email domain). */
function isEmailDomainChar(c: number): boolean {
  return isAsciiLetter(c) || isAsciiDigit(c) || c === 46 || c === 45;
}

/** End of the run of `pred` characters starting at `i`. */
function runEnd(s: string, i: number, pred: (c: number) => boolean): number {
  let j = i;
  while (j < s.length && pred(s.charCodeAt(j))) j++;
  return j;
}

/**
 * Replace every `\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` with
 * [REDACTED_JWT], same matches as that regex, in linear time: when a
 * candidate fails, every later candidate inside its first segment run would
 * end at the same place and fail too, so the search resumes after that run.
 */
export function redactJwts(s: string): string {
  let i = s.indexOf("eyJ");
  if (i === -1) return s;
  let out = "";
  let last = 0;
  while (i !== -1) {
    if (i > 0 && isWordChar(s.charCodeAt(i - 1))) {
      i = s.indexOf("eyJ", i + 1);
      continue;
    }
    const e1 = runEnd(s, i + 3, isB64UrlChar);
    let end = -1;
    if (e1 > i + 3 && s.charCodeAt(e1) === 46) {
      const e2 = runEnd(s, e1 + 1, isB64UrlChar);
      if (e2 > e1 + 1 && s.charCodeAt(e2) === 46) {
        const e3 = runEnd(s, e2 + 1, isB64UrlChar);
        if (e3 > e2 + 1) end = e3;
      }
    }
    if (end !== -1) {
      out += `${s.slice(last, i)}[REDACTED_JWT]`;
      last = end;
      i = s.indexOf("eyJ", end);
    } else {
      i = s.indexOf("eyJ", Math.max(e1, i + 1));
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * Replace every `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` with
 * [REDACTED_EMAIL], same matches as that regex, in linear time: anchored on
 * each "@" (the local part cannot contain one), the local part is the run to
 * its left and the domain ends after the right-most "." followed by two or
 * more letters.
 */
export function redactEmails(s: string): string {
  let at = s.indexOf("@");
  if (at === -1) return s;
  let out = "";
  let last = 0;
  while (at !== -1) {
    let start = at;
    while (start > last && isEmailLocalChar(s.charCodeAt(start - 1))) start--;
    let matchEnd = -1;
    if (start < at) {
      const domainEnd = runEnd(s, at + 1, isEmailDomainChar);
      // Right-most "." (with at least one domain character before it) followed by ≥ 2 letters.
      for (let j = at + 2; j < domainEnd; j++) {
        if (s.charCodeAt(j) !== 46) continue;
        const k = runEnd(s, j + 1, isAsciiLetter);
        if (k - (j + 1) >= 2) matchEnd = k;
      }
    }
    if (matchEnd !== -1) {
      out += `${s.slice(last, start)}[REDACTED_EMAIL]`;
      last = matchEnd;
      at = s.indexOf("@", matchEnd);
    } else {
      at = s.indexOf("@", at + 1);
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

/** At most `max` characters of `text`, marked when cut (never splits a surrogate pair). */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…[+${text.length - cut} chars]`;
}

const SENSITIVE_KEY_PARTS = ["authorization", "api_key", "apikey", "password", "secret", "token", "key"] as const;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactMessage(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object" && value !== null) {
    // Preserve non-plain objects (Date, RegExp, class instances, ...) as-is.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? "[REDACTED]" : redactValue(item);
    }
    return out;
  }
  return value;
}

/**
 * Recursively redact sensitive data inside an arbitrary object/array/string.
 *
 * In "metadata" mode:
 *   - property names containing authorization / api_key / apikey / password /
 *     secret / token / key have their entire value replaced with "[REDACTED]";
 *   - all other string values are passed through `redactMessage`;
 *   - non-sensitive fields and the overall structure are preserved;
 *   - the original input is never mutated (a new object is returned).
 *
 * "none" and "full" return the input unchanged (same reference).
 *
 * @param obj   the value to redact
 * @param level privacy level (defaults to "metadata")
 */
export function redactObject(obj: unknown, level: PrivacyLevel = "metadata"): unknown {
  if (level !== "metadata") return obj;
  return redactValue(obj);
}
