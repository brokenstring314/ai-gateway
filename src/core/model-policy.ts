/**
 * Model metadata enforcement (0.3.0 P3, plan §3.4).
 *
 * Before a request leaves the gateway it is checked against what the
 * published model can do. A request the model cannot serve is rejected with
 * 400 and the reason (user decision 2026-11-01: never clamp or silently
 * drop). Rewrites that keep the meaning are applied automatically:
 * developer → system, system merged into the first user message when the
 * model has no system role, reasoning_effort mapped to the upstream's
 * parameters.
 */

import type { ModelMetadata, ReasoningConfig } from "../config/types.js";
import type { ChatCompletionRequest, ChatMessage, ContentPart } from "../providers/types.js";
import { invalidRequest } from "./errors.js";
import { estimatePromptTokens } from "./usage.js";

/** Re-exported: the one shared estimator lives in core/usage.ts. */
export { estimatePromptTokens };

type Modality = NonNullable<ModelMetadata["inputModalities"]>[number];

const STRUCTURED_RANK = { none: 0, json_object: 1, json_schema: 2 } as const;

/** Input type of a content part, or undefined for text / unknown parts. */
function modalityOf(part: ContentPart): Modality | undefined {
  switch (part.type) {
    case "image_url":
      return "image";
    case "input_audio":
      return "audio";
    case "video_url":
    case "input_video":
      return "video";
    case "file":
    case "input_file":
      return "pdf";
    default:
      return undefined;
  }
}

const MODALITY_LABEL: Record<Modality, string> = {
  text: "text",
  image: "image",
  audio: "audio",
  video: "video",
  pdf: "file/PDF",
};

/**
 * Output-token limit and context window checks; shared by chat and legacy
 * completions. A model without a published maxOutputTokens is held to the
 * gateway-wide `globalMaxOutputTokens` (limits.maxOutputTokens, review
 * 2026-11-02 RB6): over it is a 400, never clamped.
 */
/**
 * The request's effective output cap (review 2026-11-05 F1): the LARGER of
 * max_tokens and max_completion_tokens when both are present. Upstreams honour
 * one or the other (DeepSeek and most OpenAI-compatible servers read
 * max_tokens, OpenAI reasoning models max_completion_tokens) and both are
 * forwarded, so the limit check and the key meter's reservation must hold
 * the request to the larger one. `param` names that field.
 */
export function outputCapOf(
  req: Pick<ChatCompletionRequest, "maxTokens" | "maxCompletionTokens">,
): { readonly value: number; readonly param: "max_tokens" | "max_completion_tokens" } | undefined {
  const a = typeof req.maxTokens === "number" ? req.maxTokens : undefined;
  const b = typeof req.maxCompletionTokens === "number" ? req.maxCompletionTokens : undefined;
  if (a === undefined && b === undefined) return undefined;
  if (b === undefined || (a !== undefined && a > b)) return { value: a as number, param: "max_tokens" };
  return { value: b, param: "max_completion_tokens" };
}

/**
 * Reasoning / thinking budget fields a client can send (forwarded upstream
 * through the allow-listed extras, providers/wire-extras.ts), by wire path.
 * Upstreams spend up to that many hidden reasoning tokens, often on top of
 * max_tokens (final red team 2026-11-06 FQ-1), so the limit check and the key
 * meter's reservation hold the request to the largest of them as well.
 */
export const REASONING_BUDGET_FIELDS: readonly (readonly [string, string])[] = [
  ["reasoning", "max_tokens"], // OpenRouter
  ["thinking", "budget_tokens"], // Anthropic-style (DeepSeek / Qwen / GLM compatible endpoints …)
  ["thinking", "max_tokens"],
  ["chat_template_kwargs", "thinking_budget"], // vLLM / SGLang chat templates
  ["chat_template_kwargs", "max_thinking_tokens"],
];

/** A token count the upstream may coerce: a finite number, or a numeric string. */
function tokenCount(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/** The largest reasoning budget in `extra` (and the `param` naming it), or undefined. */
export function reasoningBudgetOf(
  extra: Readonly<Record<string, unknown>> | undefined,
): { readonly value: number; readonly param: string } | undefined {
  if (!extra) return undefined;
  let best: { value: number; param: string } | undefined;
  for (const [outer, inner] of REASONING_BUDGET_FIELDS) {
    const o = extra[outer];
    if (o === null || typeof o !== "object" || Array.isArray(o)) continue;
    const v = tokenCount((o as Record<string, unknown>)[inner]);
    if (v !== undefined && (best === undefined || v > best.value)) best = { value: v, param: `${outer}.${inner}` };
  }
  return best;
}

/**
 * The request's whole requested output ceiling (FQ-1): the largest of
 * max_tokens / max_completion_tokens (outputCapOf) and any reasoning budget
 * field. Undefined when the client set none of them.
 */
export function requestedOutputCapOf(
  req: Pick<ChatCompletionRequest, "maxTokens" | "maxCompletionTokens" | "extra">,
): { readonly value: number; readonly param: string } | undefined {
  const cap = outputCapOf(req);
  const budget = reasoningBudgetOf(req.extra);
  if (budget !== undefined && (cap === undefined || budget.value > cap.value)) return budget;
  return cap;
}

export function checkLimits(
  req: ChatCompletionRequest,
  meta: ModelMetadata | undefined,
  model: string,
  globalMaxOutputTokens?: number,
): void {
  // Both output-limit fields with different values (F1): ambiguous — which
  // one the upstream honours depends on the upstream — so the request is
  // refused instead of guessing (never clamp or drop silently).
  if (
    req.maxTokens !== undefined &&
    req.maxCompletionTokens !== undefined &&
    req.maxTokens !== req.maxCompletionTokens
  ) {
    throw invalidRequest(
      `max_tokens (${req.maxTokens}) and max_completion_tokens (${req.maxCompletionTokens}) are both set ` +
        "and differ. Send only one of them (or the same value in both).",
      "conflicting_max_tokens",
      "max_completion_tokens",
    );
  }
  // max_tokens / max_completion_tokens and the reasoning budget fields (FQ-1):
  // a budget over the limit is refused like an over-limit max_tokens.
  const cap = requestedOutputCapOf(req);
  const requested = cap?.value;
  const param = cap?.param ?? "max_tokens";
  const own = meta?.maxOutputTokens;
  const limit = own ?? globalMaxOutputTokens;
  if (limit !== undefined && requested !== undefined && requested > limit) {
    throw invalidRequest(
      own !== undefined
        ? `${param} is ${requested}, but the model "${model}" outputs at most ${own} tokens. ` +
            `Set ${param} to ${own} or less.`
        : `${param} is ${requested}, but this gateway allows at most ${limit} output tokens per request ` +
            `for the model "${model}" (limits.maxOutputTokens). Set ${param} to ${limit} or less.`,
      "max_tokens_exceeded",
      param,
    );
  }
  if (!meta) return;
  if (meta.contextWindow !== undefined) {
    const input = estimatePromptTokens(req);
    const total = input + (requested ?? 0);
    if (total > meta.contextWindow) {
      throw invalidRequest(
        `This request needs about ${input} input tokens${requested !== undefined ? ` plus ${param} ${requested}` : ""}, ` +
          `more than the model "${model}"'s context window of ${meta.contextWindow} tokens. ` +
          "Shorten the messages or lower the output limit.",
        "context_length_exceeded",
        "messages",
      );
    }
  }
}

function reject(model: string, what: string, code: string, param: string): never {
  throw invalidRequest(`The model "${model}" does not support ${what}.`, code, param);
}

function reasoningOf(meta: ModelMetadata): ReasoningConfig | boolean | undefined {
  return meta.reasoning;
}

/**
 * Check `req` against `meta` and apply the meaning-preserving rewrites.
 * Throws a 400 GatewayError naming the problem; returns the (possibly new) request.
 */
export function enforceChatPolicy(
  req: ChatCompletionRequest,
  meta: ModelMetadata | undefined,
  model: string,
  globalMaxOutputTokens?: number,
): ChatCompletionRequest {
  let out = req;
  const m = meta ?? {};

  // developer → system (same meaning; some upstreams reject the role).
  if (m.developerRole !== "passthrough" && out.messages.some((msg) => msg.role === "developer")) {
    out = {
      ...out,
      messages: out.messages.map((msg) => (msg.role === "developer" ? { ...msg, role: "system" } : msg)),
    };
  }
  // Input types first: an image sent to a text-only model is that, not a
  // context overflow (images count ~1,600 tokens each in the estimate, FQ-1).
  if (meta?.inputModalities !== undefined) {
    const allowed = new Set<Modality>(meta.inputModalities);
    for (const msg of out.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        const kind = modalityOf(part);
        if (kind !== undefined && !allowed.has(kind)) {
          reject(model, `${MODALITY_LABEL[kind]} input`, "unsupported_input_modality", "messages");
        }
      }
    }
  }
  checkLimits(out, meta, model, globalMaxOutputTokens);
  if (!meta) return out;

  // Tools.
  const hasTools = (out.tools?.length ?? 0) > 0;
  if (meta.tools === false && hasTools) reject(model, "tool calls", "tools_not_supported", "tools");
  if (meta.parallelTools === false && out.parallelToolCalls === true) {
    reject(model, "parallel tool calls", "parallel_tool_calls_not_supported", "parallel_tool_calls");
  }

  // Structured output.
  const format = out.responseFormat?.type;
  if (meta.structuredOutput !== undefined && (format === "json_object" || format === "json_schema")) {
    if (STRUCTURED_RANK[format] > STRUCTURED_RANK[meta.structuredOutput]) {
      reject(model, `response_format "${format}"`, "unsupported_response_format", "response_format");
    }
  }

  // Log probabilities.
  if (meta.logprobs === false && (out.logprobs === true || out.topLogprobs !== undefined)) {
    reject(model, "logprobs", "logprobs_not_supported", out.logprobs === true ? "logprobs" : "top_logprobs");
  }

  // Web search.
  if (meta.webSearch === false && out.extra?.["web_search_options"] !== undefined) {
    reject(model, "web search", "web_search_not_supported", "web_search_options");
  }

  // Reasoning.
  const effort = out.extra?.["reasoning_effort"];
  const reasoning = reasoningOf(meta);
  if (effort !== undefined) {
    if (reasoning === false) reject(model, "reasoning_effort", "reasoning_not_supported", "reasoning_effort");
    if (typeof reasoning === "object") {
      const value = String(effort);
      if (reasoning.efforts !== undefined && !reasoning.efforts.includes(value)) {
        throw invalidRequest(
          `reasoning_effort "${value}" is not supported by the model "${model}"; use one of: ${reasoning.efforts.join(", ")}.`,
          "unsupported_reasoning_effort",
          "reasoning_effort",
        );
      }
      const mapped = reasoning.map?.[value];
      if (mapped !== undefined) {
        const { reasoning_effort: _drop, ...rest } = out.extra ?? {};
        out = { ...out, extra: { ...rest, ...structuredClone(mapped) } };
      }
    }
  }

  // No system role upstream: prepend system text to the first user message.
  if (meta.systemMessage === "merge_into_user" && out.messages.some((msg) => msg.role === "system")) {
    out = { ...out, messages: mergeSystemIntoUser(out.messages) };
  }
  return out;
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter((t) => t !== "")
    .join("\n");
}

function mergeSystemIntoUser(messages: readonly ChatMessage[]): ChatMessage[] {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .filter((t) => t !== "")
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const i = rest.findIndex((m) => m.role === "user");
  if (system === "") return rest;
  if (i === -1) return [{ role: "user", content: system }, ...rest];
  const user = rest[i]!;
  const merged: ChatMessage =
    typeof user.content === "string" || user.content === undefined
      ? { ...user, content: `${system}\n\n${user.content ?? ""}` }
      : { ...user, content: [{ type: "text", text: system }, ...user.content] };
  return [...rest.slice(0, i), merged, ...rest.slice(i + 1)];
}
