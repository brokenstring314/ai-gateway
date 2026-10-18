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

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
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
 *
 * @param message the raw message
 * @param level   privacy level ("none" and "full" return the input unchanged)
 */
export function redactMessage(message: string, level: PrivacyLevel = "metadata"): string {
  if (level !== "metadata") return message;

  let out = message;
  out = out.replace(BEARER_RE, "[REDACTED_BEARER]");
  out = out.replace(JWT_RE, "[REDACTED_JWT]");
  out = out.replace(SK_KEY_RE, "[REDACTED_KEY]");
  out = out.replace(FGW_KEY_RE, "[REDACTED_KEY]");
  out = out.replace(AWS_KEY_RE, "[REDACTED_AWS_KEY]");
  out = out.replace(EMAIL_RE, "[REDACTED_EMAIL]");
  return out;
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
