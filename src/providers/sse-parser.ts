/**
 * SSE (Server-Sent Events) stream parser for OpenAI-compatible streaming responses.
 *
 * Handles the OpenAI SSE wire format:
 *   data: {"id":"...","choices":[...]}\n\n
 *   data: [DONE]\n\n
 *
 * Handles comment lines, partial UTF-8 reads, multi-line data events, and
 * graceful abort via AbortSignal.
 */

import type { StreamChunk, ChatMessage } from "./types.js";

/** Sentinel value marking the end of an SSE stream. */
const DONE_SENTINEL = "[DONE]";

/**
 * Parse a ReadableStream of bytes into an async iterable of StreamChunk objects.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel("aborted");
        return;
      }

      let result: { done: boolean; value?: Uint8Array };
      try {
        result = await reader.read();
      } catch (err) {
        throw new ReadableStreamError(
          `SSE stream read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      const [newBuffer, chunks] = processBuffer(buffer);
      buffer = newBuffer;
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    buffer += decoder.decode();
    const [, finalChunks] = processBuffer(buffer);
    for (const chunk of finalChunks) {
      yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Process line buffer: split on \n, accumulate data lines, parse events. */
function processBuffer(buffer: string): [string, StreamChunk[]] {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  let dataLines: string[] = [];
  const chunks: StreamChunk[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (trimmed === "") {
      if (dataLines.length > 0) {
        const parsed = parseSSEEvent(dataLines);
        if (parsed !== null) chunks.push(parsed);
        dataLines = [];
      }
      continue;
    }

    if (trimmed.startsWith(":")) continue;

    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trimStart());
      continue;
    }
  }

  const newBuffer = dataLines.length > 0
    ? dataLines.join("\n") + "\n" + remainder
    : remainder;

  return [newBuffer, chunks];
}

function parseSSEEvent(dataLines: string[]): StreamChunk | null {
  const raw = dataLines.join("\n");
  if (raw === DONE_SENTINEL) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("choices" in parsed)) {
    return null;
  }

  return normalizeChunk(parsed as Record<string, unknown>);
}

function normalizeChunk(raw: Record<string, unknown>): StreamChunk {
  const rawChoices = raw["choices"];
  const choices = Array.isArray(rawChoices)
    ? (rawChoices as Record<string, unknown>[]).map((c, i) => ({
        index: typeof c["index"] === "number" ? (c["index"] as number) : i,
        delta: normalizeDeltaMessage(c["delta"]),
        finishReason: normalizeFinishReason(String(c["finish_reason"] ?? "")),
      }))
    : [];

  const usageRaw = raw["usage"] as Record<string, number> | undefined;

  return {
    id: String(raw["id"] ?? ""),
    object: String(raw["object"] ?? "chat.completion.chunk"),
    created: typeof raw["created"] === "number" ? (raw["created"] as number) : 0,
    model: String(raw["model"] ?? ""),
    choices,
    usage: usageRaw
      ? {
          promptTokens: usageRaw["prompt_tokens"] ?? 0,
          completionTokens: usageRaw["completion_tokens"] ?? 0,
          totalTokens: usageRaw["total_tokens"] ?? 0,
        }
      : undefined,
  };
}

function normalizeDeltaMessage(raw: unknown): ChatMessage {
  if (typeof raw !== "object" || raw === null) {
    return { role: "assistant" };
  }
  const r = raw as Record<string, unknown>;

  const message: ChatMessage = {
    role: narrowRole(String(r["role"] ?? "assistant")),
  };

  const content = r["content"];
  if (typeof content === "string") {
    message.content = content;
  }

  const toolCalls = r["tool_calls"];
  if (Array.isArray(toolCalls)) {
    message.toolCalls = (toolCalls as Record<string, unknown>[]).map((tc) => ({
      id: String(tc["id"] ?? ""),
      type: "function" as const,
      function: {
        name: String((tc["function"] as Record<string, unknown>)?.["name"] ?? ""),
        arguments: String((tc["function"] as Record<string, unknown>)?.["arguments"] ?? ""),
      },
    }));
  }

  return message;
}

function narrowRole(raw: string): ChatMessage["role"] {
  if (raw === "system" || raw === "user" || raw === "assistant" || raw === "tool" || raw === "developer") {
    return raw;
  }
  return "assistant";
}

function normalizeFinishReason(raw: string): string {
  if (!raw) return "";
  const map: Record<string, string> = {
    model_length: "length",
    content_filtered: "content_filter",
  };
  return map[raw] ?? raw;
}

export class ReadableStreamError extends Error {
  override name = "ReadableStreamError";
}
