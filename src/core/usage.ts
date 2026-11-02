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

/** ~4 characters per token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function messageText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

/** Characters of prompt text in a request (all messages). */
export function promptChars(req: Pick<ChatCompletionRequest, "messages">): number {
  let n = 0;
  for (const msg of req.messages) n += messageText(msg.content).length;
  return n;
}

/** Estimated prompt tokens of a request. */
export function estimatePromptTokens(req: Pick<ChatCompletionRequest, "messages">): number {
  return estimateTokens(promptChars(req));
}

/** What a stream delivered so far (content, finish reason, usage chunk). */
export interface StreamAccumulator {
  id: string;
  created: number;
  model: string;
  content: string;
  toolArgChars: number;
  /** Characters of delta.reasoning_content / delta.reasoning / delta.refusal (reasoning models). */
  reasoningChars: number;
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
    toolArgChars: 0,
    reasoningChars: 0,
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
        if (typeof args?.arguments === "string") acc.toolArgChars += args.arguments.length;
        if (typeof args?.name === "string") acc.toolArgChars += args.name.length;
      }
      const extra = delta.extra;
      if (extra) {
        for (const key of ESTIMATED_DELTA_EXTRAS) {
          const v = extra[key];
          if (typeof v === "string") acc.reasoningChars += v.length;
        }
      }
    }
    if (choice?.finishReason) acc.finishReason = choice.finishReason;
  }
}

/**
 * Usage for a stream that sent no usage chunk: estimated (~4 chars/token)
 * so token quotas cannot be bypassed by omitting stream_options.include_usage.
 */
export function estimateStreamUsage(req: Pick<ChatCompletionRequest, "messages">, acc: StreamAccumulator): Usage {
  const promptTokens = estimatePromptTokens(req);
  const completionTokens = estimateTokens(acc.content.length + acc.toolArgChars + acc.reasoningChars);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
