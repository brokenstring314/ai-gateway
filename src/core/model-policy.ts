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

/** Output-token limit and context window checks; shared by chat and legacy completions. */
export function checkLimits(req: ChatCompletionRequest, meta: ModelMetadata | undefined, model: string): void {
  if (!meta) return;
  const requested = req.maxCompletionTokens ?? req.maxTokens;
  const param = req.maxCompletionTokens !== undefined ? "max_completion_tokens" : "max_tokens";
  if (meta.maxOutputTokens !== undefined && requested !== undefined && requested > meta.maxOutputTokens) {
    throw invalidRequest(
      `${param} is ${requested}, but the model "${model}" outputs at most ${meta.maxOutputTokens} tokens. ` +
        `Set ${param} to ${meta.maxOutputTokens} or less.`,
      "max_tokens_exceeded",
      param,
    );
  }
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
  if (!meta) return out;

  checkLimits(out, meta, model);

  // Input types.
  if (meta.inputModalities !== undefined) {
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
