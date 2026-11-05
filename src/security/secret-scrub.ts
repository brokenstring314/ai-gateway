/**
 * Removing the operator's upstream credentials from upstream error text
 * (red team 2026-11-05 P3). Some OpenAI-compatible upstreams echo the key
 * they received ("Incorrect API key provided: Bearer sk-…"); that text used
 * to reach the client's error message, GET /admin/logs and stdout verbatim.
 *
 * Every known secret of the channel (all its keys, not only the one used) is
 * replaced by "[key]", then anything key-shaped: `sk-` / `pk-` / `rk-` /
 * `key-` tokens (masked echoes like "sk-abc***xyz" included), `fgw_` gateway
 * keys and `Bearer <token>`. Linear in the text length (one split per known
 * secret; the patterns start with a literal and cannot backtrack over a run
 * per start position).
 */

const KEY_LIKE_RE = /\b(?:sk|pk|rk|key)[-_][A-Za-z0-9_*.-]{6,}/gi;
const GATEWAY_KEY_RE = /\bfgw_[A-Za-z0-9_-]{4,}/g;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=*-]{8,}/gi;

/** Shortest secret replaced by exact match (shorter ones would mangle ordinary words). */
const MIN_SECRET_LENGTH = 6;

/** `text` with every known secret and anything key-shaped replaced by "[key]". */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= MIN_SECRET_LENGTH && out.includes(s)) out = out.split(s).join("[key]");
  }
  out = out.replace(BEARER_RE, "$1 [key]");
  out = out.replace(KEY_LIKE_RE, "[key]");
  out = out.replace(GATEWAY_KEY_RE, "[key]");
  return out;
}

/** A copy of an upstream error body object with every string field scrubbed. */
export function scrubRecord<T extends Record<string, unknown>>(rec: T, secrets: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = typeof v === "string" ? scrubSecrets(v, secrets) : v;
  return out as T;
}
