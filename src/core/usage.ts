/**
 * Usage helpers shared by the pipeline, the key meter and metrics
 * (refactor plan §1.2 core/usage.ts).
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ContentPart,
  StreamChunk,
  Usage,
} from "../providers/types.js";

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
 * Conservative token counts for the non-text content parts of a request
 * (final red team 2026-11-06 FQ-1). Upstreams bill images, audio and files
 * as hundreds to tens of thousands of input tokens; counting them as 0 let a
 * key with a small quota reserve almost nothing per request and so get
 * hundreds of concurrent requests admitted. The figures are deliberately on
 * the high side of what the major OpenAI-compatible upstreams charge; tune
 * them here (one table, used by the key meter's reservation, the context
 * window check and the usage estimate when an upstream reports no usage).
 */
export const NON_TEXT_PART_TOKENS = {
  /**
   * Per image_url part, whatever its `detail`: a large high-detail image is
   * ~1,100–1,600 tokens on OpenAI / Anthropic-style upstreams, and not every
   * upstream honours detail "low".
   */
  image: 1_600,
  /** Per input_audio part, at least (a short clip). */
  audioMin: 2_000,
  /** Decoded audio bytes per token above audioMin (≈ low-bitrate speech at ~32 tokens / s). */
  audioBytesPerToken: 128,
  /** Per file / input_file part with inline data, at least. */
  fileMin: 4_000,
  /** Decoded file bytes per token above fileMin (PDF pages are billed as text plus a page image). */
  fileBytesPerToken: 32,
  /** A file part referenced by id or URL (its size is unknown to the gateway). */
  fileRef: 8_000,
  /** Per video_url / input_video part (length unknown: ~2 minutes at Gemini-style rates). */
  video: 32_000,
} as const;

/** Bytes a base64 (or data: URL) payload decodes to. */
function base64Bytes(data: unknown): number {
  if (typeof data !== "string" || data.length === 0) return 0;
  const comma = data.startsWith("data:") ? data.indexOf(",") : -1;
  return Math.floor(((data.length - (comma + 1)) * 3) / 4);
}

function partObject(part: ContentPart, key: string): Record<string, unknown> | undefined {
  const v = part.raw?.[key];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Estimated input tokens of one non-text content part (FQ-1): images,
 * audio, files and video at the conservative NON_TEXT_PART_TOKENS rates;
 * any other part type the gateway forwards verbatim (refusal …) by the size
 * of its JSON. Text parts are counted by the caller.
 */
export function estimateNonTextPartTokens(part: ContentPart): number {
  const t = NON_TEXT_PART_TOKENS;
  switch (part.type) {
    case "text":
      return 0;
    case "image_url":
    case "input_image":
      return t.image;
    case "input_audio": {
      const bytes = base64Bytes(partObject(part, "input_audio")?.["data"]);
      return Math.max(t.audioMin, Math.ceil(bytes / t.audioBytesPerToken));
    }
    case "file":
    case "input_file": {
      const f = partObject(part, "file") ?? part.raw ?? {};
      const bytes = base64Bytes(f["file_data"]);
      if (bytes === 0) return t.fileRef;
      return Math.max(t.fileMin, Math.ceil(bytes / t.fileBytesPerToken));
    }
    case "video_url":
    case "input_video":
      return t.video;
    default:
      return part.raw ? estimateTextTokens(JSON.stringify(part.raw)) : 0;
  }
}

/** Estimated tokens of a message's content: its text plus its non-text parts (FQ-1). */
export function estimateContentTokens(content: ChatCompletionRequest["messages"][number]["content"]): number {
  if (!Array.isArray(content)) return estimateTextTokens(messageText(content));
  let tokens = estimateTextTokens(messageText(content));
  for (const p of content) {
    if (p && typeof p === "object") tokens += estimateNonTextPartTokens(p);
  }
  return tokens;
}

/** The request fields estimatePromptTokens reads. */
export type PromptEstimateInput = Pick<ChatCompletionRequest, "messages"> &
  Partial<Pick<ChatCompletionRequest, "tools" | "responseFormat" | "extra">>;

/**
 * Estimated prompt tokens of a request: message text, non-text parts
 * (images, audio, files, video — FQ-1), tool-call arguments and the
 * message's forwarded extras (reasoning_content …), the declared tools'
 * JSON, a json_schema response format and a `prediction`, plus 4 tokens of
 * framing per message.
 */
export function estimatePromptTokens(req: PromptEstimateInput): number {
  let tokens = 0;
  for (const m of req.messages ?? []) {
    tokens += 4 + estimateContentTokens(m.content);
    for (const tc of m.toolCalls ?? []) tokens += estimateTextTokens(tc.function?.arguments ?? "");
    if (m.extra && Object.keys(m.extra).length > 0) tokens += estimateTextTokens(JSON.stringify(m.extra));
  }
  if (req.tools && req.tools.length > 0) tokens += estimateTextTokens(JSON.stringify(req.tools));
  const schema = req.responseFormat?.jsonSchema;
  if (schema !== undefined) tokens += estimateTextTokens(JSON.stringify(schema));
  const prediction = req.extra?.["prediction"];
  if (prediction !== undefined) tokens += estimateTextTokens(JSON.stringify(prediction));
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
  /**
   * Estimated tokens of text past STREAM_ACCUMULATOR_MAX_CHARS that was not
   * kept (review 2026-11-05 D6): still counted by estimateStreamUsage.
   */
  overflowTokens: number;
  /** Some streamed text was not kept (the accumulator hit its cap). */
  truncated: boolean;
}

/**
 * Most characters of streamed text (content + tool-call text + reasoning) a
 * stream keeps for after-request plugins and the usage estimate (review
 * 2026-11-05 D6). Past it the text is only counted (estimated tokens), so a
 * very long answer cannot grow the gateway's memory without bound; the stream
 * itself is never cut for this.
 */
export const STREAM_ACCUMULATOR_MAX_CHARS = 1_048_576;

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
    overflowTokens: 0,
    truncated: false,
  };
}

/** Append streamed text to one accumulator field, or only count it once the accumulator is full. */
function keep(acc: StreamAccumulator, field: "content" | "toolArgText" | "reasoningText", text: string): void {
  if (text === "") return;
  const held = acc.content.length + acc.toolArgText.length + acc.reasoningText.length;
  if (held + text.length <= STREAM_ACCUMULATOR_MAX_CHARS) {
    acc[field] += text;
    return;
  }
  acc.overflowTokens += estimateTextTokens(text);
  acc.truncated = true;
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
      if (typeof delta.content === "string") keep(acc, "content", delta.content);
      for (const tc of delta.toolCalls ?? []) {
        const args = (tc as { function?: { arguments?: unknown; name?: unknown } }).function;
        if (typeof args?.arguments === "string") keep(acc, "toolArgText", args.arguments);
        if (typeof args?.name === "string") keep(acc, "toolArgText", args.name);
      }
      const extra = delta.extra;
      if (extra) {
        for (const key of ESTIMATED_DELTA_EXTRAS) {
          const v = extra[key];
          if (typeof v === "string") keep(acc, "reasoningText", v);
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
export function estimateStreamUsage(req: PromptEstimateInput, acc: StreamAccumulator): Usage {
  const promptTokens = estimatePromptTokens(req);
  const completionTokens =
    estimateTextTokens(acc.content) +
    estimateTextTokens(acc.toolArgText) +
    estimateTextTokens(acc.reasoningText) +
    acc.overflowTokens;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/**
 * Completion tokens of a non-streaming chat response, estimated from what
 * it returned: message content (text parts), tool-call names and
 * arguments, and reasoning / refusal text, over every choice.
 */
export function estimateResponseCompletionTokens(res: Pick<ChatCompletionResponse, "choices"> | undefined): number {
  let tokens = 0;
  for (const choice of res?.choices ?? []) {
    const m = choice?.message;
    if (!m) continue;
    tokens += estimateTextTokens(messageText(m.content));
    for (const tc of m.toolCalls ?? []) {
      const fn = (tc as { function?: { arguments?: unknown; name?: unknown } }).function;
      if (typeof fn?.arguments === "string") tokens += estimateTextTokens(fn.arguments);
      if (typeof fn?.name === "string") tokens += estimateTextTokens(fn.name);
    }
    const extra = m.extra;
    if (extra) {
      for (const key of ESTIMATED_DELTA_EXTRAS) {
        const v = extra[key];
        if (typeof v === "string") tokens += estimateTextTokens(v);
      }
    }
  }
  return tokens;
}

/** Estimated usage of a non-streaming chat request and its response (upstream reported none). */
export function estimateChatUsage(
  req: PromptEstimateInput,
  res: Pick<ChatCompletionResponse, "choices"> | undefined,
): Usage {
  const promptTokens = estimatePromptTokens(req);
  const completionTokens = estimateResponseCompletionTokens(res);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function validCount(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * The usage a request is metered with (review 2026-11-02 RB1 / C3): the
 * upstream's when it is plausible, otherwise the shared estimate. Not
 * plausible: missing; a negative, NaN or non-numeric count; all counts zero
 * while the request had input or the response had output; or zero
 * completion tokens although the response returned output. `estimate` is
 * only called when the reported usage needs checking against it.
 */
export function resolveUsage(
  reported: Usage | undefined,
  estimate: () => Usage,
): { readonly usage: Usage; readonly estimated: boolean } {
  if (
    reported === undefined ||
    reported === null ||
    typeof reported !== "object" ||
    !validCount(reported.promptTokens) ||
    !validCount(reported.completionTokens) ||
    !validCount(reported.totalTokens)
  ) {
    return { usage: estimate(), estimated: true };
  }
  const total = Math.max(reported.totalTokens, reported.promptTokens + reported.completionTokens);
  if (total > 0 && reported.completionTokens > 0) return { usage: reported, estimated: false };
  const est = estimate();
  if (total === 0) {
    return est.totalTokens > 0 ? { usage: est, estimated: true } : { usage: reported, estimated: false };
  }
  // Prompt counted, completion reported as 0: only plausible when nothing was returned.
  if (est.completionTokens > 0) {
    const completionTokens = est.completionTokens;
    return {
      usage: {
        ...reported,
        completionTokens,
        totalTokens: reported.promptTokens + completionTokens,
      },
      estimated: true,
    };
  }
  return { usage: reported, estimated: false };
}
