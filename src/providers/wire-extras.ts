/**
 * Allow-listed pass-through of OpenAI wire fields the gateway does not model.
 *
 * The internal types (providers/types.ts) only carry the fields the gateway
 * acts on. Everything else a client or an upstream sends used to be dropped:
 * reasoning models lost `reasoning_content`, Perplexity lost `citations`,
 * `logprobs` came back null, `reasoning_effort` / `tools[].function.strict`
 * never reached the upstream (T3-9, T3-11).
 *
 * Fields on these lists travel in an `extra` bag keyed by their wire
 * (snake_case) name and are copied back verbatim on the other side. Typed
 * fields always win over an `extra` entry of the same name. The lists are
 * allow-lists on purpose: an unknown key is still dropped, so a client cannot
 * smuggle e.g. `api_key` or `base_url` style knobs to an upstream, and the
 * gateway's own response shape stays predictable.
 */

type Json = Record<string, unknown>;

/** Top-level chat/completions request fields forwarded upstream as-is. */
export const REQUEST_EXTRA_KEYS: readonly string[] = [
  // OpenAI
  "reasoning_effort",
  "verbosity",
  "store",
  "metadata",
  "modalities",
  "audio",
  "prediction",
  "service_tier",
  "web_search_options",
  "prompt_cache_key",
  "safety_identifier",
  // Common OpenAI-compatible provider knobs (vLLM, Together, DeepSeek, Qwen, OpenRouter, Perplexity …)
  "top_k",
  "min_p",
  "repetition_penalty",
  "reasoning",
  "thinking",
  "enable_thinking",
  "chat_template_kwargs",
  "search_domain_filter",
  "search_recency_filter",
  "return_images",
  "return_related_questions",
];

/** Request message fields forwarded upstream (multi-turn reasoning, prefix completion …). */
export const REQUEST_MESSAGE_EXTRA_KEYS: readonly string[] = [
  "reasoning_content",
  "reasoning",
  "reasoning_details",
  "refusal",
  "audio",
  "prefix",
];

/** Top-level response / stream-chunk fields returned to the client. */
export const RESPONSE_EXTRA_KEYS: readonly string[] = [
  "system_fingerprint",
  "service_tier",
  "citations",
  "search_results",
  "images",
  "related_questions",
  "prompt_filter_results",
];

/** Choice-level response fields (besides `logprobs`, which is typed). */
export const CHOICE_EXTRA_KEYS: readonly string[] = ["content_filter_results", "stop_reason"];

/** Response message / stream delta fields returned to the client. */
export const RESPONSE_MESSAGE_EXTRA_KEYS: readonly string[] = [
  "reasoning_content",
  "reasoning",
  "reasoning_details",
  "refusal",
  "annotations",
  "audio",
];

/** Usage fields besides the token counts and `*_tokens_details` (which are typed). */
export const USAGE_EXTRA_KEYS: readonly string[] = [
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "cost",
  "cost_details",
];

export function isJsonObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The allow-listed keys present on `raw` (undefined values skipped), or undefined when none. */
export function pickExtras(raw: unknown, keys: readonly string[]): Json | undefined {
  if (!isJsonObject(raw)) return undefined;
  let out: Json | undefined;
  for (const k of keys) {
    if (k in raw && raw[k] !== undefined) {
      out ??= {};
      out[k] = raw[k];
    }
  }
  return out;
}

/** Copy `extra` onto `target` without overwriting keys the target already set. */
export function applyExtras(target: Json, extra: Json | undefined): Json {
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (!(k in target) && v !== undefined) target[k] = v;
    }
  }
  return target;
}

/** Numeric-valued `*_tokens_details` object, or undefined. */
export function tokenDetails(raw: unknown): Record<string, number> | undefined {
  if (!isJsonObject(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalise an upstream wire `usage` object into the internal shape (details and extras kept). */
export function normalizeWireUsage(raw: unknown):
  | {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      promptTokensDetails?: Record<string, number>;
      completionTokensDetails?: Record<string, number>;
      extra?: Json;
    }
  | undefined {
  if (!isJsonObject(raw)) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const usage: ReturnType<typeof normalizeWireUsage> & object = {
    promptTokens: num(raw["prompt_tokens"]),
    completionTokens: num(raw["completion_tokens"]),
    totalTokens: num(raw["total_tokens"]),
  };
  const ptd = tokenDetails(raw["prompt_tokens_details"]);
  if (ptd) usage.promptTokensDetails = ptd;
  const ctd = tokenDetails(raw["completion_tokens_details"]);
  if (ctd) usage.completionTokensDetails = ctd;
  const extra = pickExtras(raw, USAGE_EXTRA_KEYS);
  if (extra) usage.extra = extra;
  return usage;
}
