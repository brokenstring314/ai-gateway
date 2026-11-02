/**
 * Usage helpers shared by the pipeline, the key meter and metrics
 * (refactor plan §1.2 core/usage.ts).
 */

import type { ChatCompletionRequest, StreamChunk, Usage } from "../providers/types.js";

/** Sum two usages (MCP rounds). Token details are not summed: they are kept from the last round only. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    ...b,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * CJK ideographs, kana, hangul and full-width forms: tokenizers (OpenAI
 * o200k, DeepSeek, Qwen …) spend roughly 0.6–1 token per character, so each
 * counts as one token (conservative).
 */
const CJK_RE =
  /[\u1100-\u11ff\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u31ff\u3200-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]|[\u{20000}-\u{3134f}]/gu;

const utf8 = new TextEncoder();

/**
 * The gateway's one token estimator (stream / response usage fallback and
 * the model policy's context-window check): CJK characters count one token
 * each, all other text UTF-8 bytes / 4 (≈ 4 ASCII characters per token).
 * Only used when the upstream reports no usage.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  const rest = text.replace(CJK_RE, () => {
    cjk++;
    return "";
  });
  return cjk + Math.ceil(utf8.encode(rest).length / 4);
}

export function messageText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

/**
 * Estimated prompt tokens of a request: message text and tool-call
 * arguments, the declared tools' JSON, plus 4 tokens of framing per message.
 */
export function estimatePromptTokens(
  req: Pick<ChatCompletionRequest, "messages"> & Partial<Pick<ChatCompletionRequest, "tools">>,
): number {
  let tokens = 0;
  for (const m of req.messages ?? []) {
    tokens += 4 + estimateTextTokens(messageText(m.content));
    for (const tc of m.toolCalls ?? []) tokens += estimateTextTokens(tc.function?.arguments ?? "");
  }
  if (req.tools && req.tools.length > 0) tokens += estimateTextTokens(JSON.stringify(req.tools));
  return tokens;
}

/** What a stream delivered so far (content, finish reason, usage chunk). */
export interface StreamAccumulator {
  id: string;
  created: number;
  model: string;
  content: string;
  /** Tool-call names and arguments as streamed (estimate only). */
  toolArgText: string;
  /** delta.reasoning_content / delta.reasoning / delta.refusal text (reasoning models; estimate only). */
  reasoningText: string;
  finishReason: string;
  usage: Usage | undefined;
  chunks: number;
}

export function newStreamAccumulator(model: string, startTime = Date.now()): StreamAccumulator {
  return {
    id: "",
    created: Math.floor(startTime / 1000),
    model,
    content: "",
    toolArgText: "",
    reasoningText: "",
    finishReason: "",
    usage: undefined,
    chunks: 0,
  };
}

/** Generated text that travels in delta extras and costs output tokens. */
const ESTIMATED_DELTA_EXTRAS = ["reasoning_content", "reasoning", "refusal"] as const;

export function accumulateChunk(acc: StreamAccumulator, chunk: StreamChunk): void {
  acc.chunks++;
  if (chunk.id) acc.id = chunk.id;
  if (chunk.model) acc.model = chunk.model;
  if (typeof chunk.created === "number") acc.created = chunk.created;
  if (chunk.usage) acc.usage = chunk.usage;
  for (const choice of chunk.choices ?? []) {
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === "string") acc.content += delta.content;
      for (const tc of delta.toolCalls ?? []) {
        const args = (tc as { function?: { arguments?: unknown; name?: unknown } }).function;
        if (typeof args?.arguments === "string") acc.toolArgText += args.arguments;
        if (typeof args?.name === "string") acc.toolArgText += args.name;
      }
      const extra = delta.extra;
      if (extra) {
        for (const key of ESTIMATED_DELTA_EXTRAS) {
          const v = extra[key];
          if (typeof v === "string") acc.reasoningText += v;
        }
      }
    }
    if (choice?.finishReason) acc.finishReason = choice.finishReason;
  }
}

/**
 * Usage for a stream whose upstream sent no usage chunk (the gateway asks
 * for one — stream_options.include_usage — wherever the provider supports
 * it): estimated with estimateTextTokens so a token quota is not undercounted.
 */
export function estimateStreamUsage(
  req: Pick<ChatCompletionRequest, "messages"> & Partial<Pick<ChatCompletionRequest, "tools">>,
  acc: StreamAccumulator,
): Usage {
  const promptTokens = estimatePromptTokens(req);
  const completionTokens =
    estimateTextTokens(acc.content) + estimateTextTokens(acc.toolArgText) + estimateTextTokens(acc.reasoningText);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
