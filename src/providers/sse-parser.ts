/**
 * SSE (Server-Sent Events) stream parser for OpenAI-compatible streaming responses.
 *
 * Handles the OpenAI SSE wire format:
 *   data: {"id":"...","choices":[...]}\n\n
 *   data: [DONE]\n\n
 *
 * Hardening (refactor plan PR 2.5; T3-3, T3-4, T3-5, T3-10):
 *  - lines end on \r\n, \r or \n (WHATWG SSE), also when a \r\n pair is split
 *    across two network reads;
 *  - incremental scan: each read is scanned once, a partial line is kept as a
 *    list of pieces (no re-split of a growing buffer, O(n) overall);
 *  - a single line or event larger than MAX_SSE_EVENT_CHARS (4 MiB) aborts the
 *    stream with an error instead of growing memory without bound;
 *  - `data: [DONE]` ends the stream at once: the upstream body is cancelled
 *    and anything after it is ignored;
 *  - EOF without [DONE] and without any finish_reason is a truncated stream
 *    (error), not a clean completion;
 *  - malformed JSON in a data event, an `event: error` event, or an `{error}`
 *    payload is an error, never silently skipped;
 *  - non-object entries in `choices` (e.g. choices:[null]) are ignored.
 *
 * Also handles comment lines, partial UTF-8 reads, multi-line data events,
 * and graceful abort via AbortSignal.
 */

import type { StreamChunk, ChatMessage, Choice } from "./types.js";
import { ProviderError } from "./openai-compat.js";
import {
  CHOICE_EXTRA_KEYS,
  RESPONSE_EXTRA_KEYS,
  RESPONSE_MESSAGE_EXTRA_KEYS,
  normalizeWireUsage,
  pickExtras,
} from "./wire-extras.js";

function isAbortError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Sentinel value marking the end of an SSE stream. */
const DONE_SENTINEL = "[DONE]";

/** Upper bound for one SSE line, and for one event's joined data (chars ≈ bytes). */
export const MAX_SSE_EVENT_CHARS = 4 * 1024 * 1024;

/** Machine-readable reason carried by a ReadableStreamError. */
export type StreamErrorCode =
  | "upstream_stream_error"
  | "upstream_stream_truncated"
  | "upstream_empty_stream"
  | "upstream_invalid_response"
  | "upstream_event_too_large";

export class ReadableStreamError extends Error {
  override name = "ReadableStreamError";
  readonly code: StreamErrorCode;
  constructor(message: string, code: StreamErrorCode = "upstream_stream_error") {
    super(message);
    this.code = code;
  }
}

/** True for the error raised when an upstream stream ended before completion. */
export function isTruncatedStreamError(err: unknown): boolean {
  return err instanceof ReadableStreamError && err.code === "upstream_stream_truncated";
}

/**
 * Parse a ReadableStream of bytes into an async iterable of StreamChunk objects.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  providerName = "upstream",
): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const parser = new SSEParser(providerName);
  let consumed = false;

  try {
    while (true) {
      if (signal?.aborted) {
        // An abort must not look like a clean end of stream (that would make
        // a truncated answer count as a success and skip fallback/errors).
        consumed = true;
        try {
          await reader.cancel("aborted");
        } catch {
          // ignore
        }
        throw abortError();
      }

      let result: { done: boolean; value?: Uint8Array };
      try {
        result = await reader.read();
      } catch (err) {
        // A read rejected because the request was aborted (client disconnect
        // or gateway timeout) is an abort, not an upstream stream failure.
        if (signal?.aborted || isAbortError(err)) throw abortError();
        throw new ReadableStreamError(`SSE stream read failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (result.done) {
        consumed = true;
        break;
      }

      const chunks = parser.feed(decoder.decode(result.value, { stream: true }));
      for (const chunk of chunks) {
        yield chunk;
      }
      // [DONE]: stop now. `consumed` stays false, so finally cancels the
      // upstream body (it may keep the socket open after [DONE]).
      if (parser.done) return;
    }

    // EOF: treat the trailing partial line as complete and flush any pending
    // event that was not terminated by a blank line.
    for (const chunk of parser.end(decoder.decode())) {
      yield chunk;
    }
    if (!parser.done && !parser.sawFinishReason) {
      throw new ReadableStreamError(
        parser.chunkCount === 0
          ? "upstream stream ended without any event"
          : "upstream closed stream before completion (no finish_reason or [DONE])",
        parser.chunkCount === 0 ? "upstream_empty_stream" : "upstream_stream_truncated",
      );
    }
  } finally {
    if (!consumed) {
      // Consumer stopped early, [DONE] arrived, or an error occurred: cancel
      // the upstream body so the connection is not leaked.
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
    reader.releaseLock();
  }
}

const LF = 10;
const CR = 13;

/**
 * Incremental SSE parser: feed decoded text, get complete chunks back.
 * Stops (and ignores further input) once `data: [DONE]` was seen.
 */
export class SSEParser {
  /** `data: [DONE]` was seen. */
  done = false;
  /** Some choice carried a finish_reason. */
  sawFinishReason = false;
  /** Chunks emitted so far. */
  chunkCount = 0;

  private pieces: string[] = [];
  private pendingChars = 0;
  private pendingCR = false;
  private dataLines: string[] = [];
  private dataChars = 0;
  private eventType = "";
  private out: StreamChunk[] = [];

  constructor(private readonly providerName = "upstream") {}

  feed(text: string): StreamChunk[] {
    this.out = [];
    if (this.done) return this.out;
    let i = 0;
    if (this.pendingCR) {
      // A \r ended the previous read; a leading \n completes that \r\n.
      this.pendingCR = false;
      if (text.charCodeAt(0) === LF) i = 1;
    }
    const n = text.length;
    while (i < n && !this.done) {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === LF || c === CR) break;
        j++;
      }
      if (j === n) {
        this.appendPartial(text.slice(i));
        break;
      }
      const tail = text.slice(i, j);
      const line = this.pieces.length > 0 ? this.pieces.join("") + tail : tail;
      if (this.pieces.length > 0) this.checkSize(this.pendingChars + tail.length);
      this.pieces = [];
      this.pendingChars = 0;
      if (text.charCodeAt(j) === CR) {
        if (j + 1 < n) {
          if (text.charCodeAt(j + 1) === LF) j++;
        } else {
          this.pendingCR = true;
        }
      }
      i = j + 1;
      this.processLine(line);
    }
    return this.out;
  }

  /** End of input: the trailing partial line is a line, a pending event is dispatched. */
  end(text = ""): StreamChunk[] {
    const chunks = this.feed(text);
    if (this.done) return chunks;
    this.out = chunks;
    if (this.pieces.length > 0) {
      const line = this.pieces.join("");
      this.pieces = [];
      this.pendingChars = 0;
      this.processLine(line);
    }
    if (!this.done) this.dispatch();
    return this.out;
  }

  private appendPartial(s: string): void {
    if (s === "") return;
    this.pendingChars += s.length;
    this.checkSize(this.pendingChars);
    this.pieces.push(s);
  }

  private checkSize(chars: number): void {
    if (chars > MAX_SSE_EVENT_CHARS) {
      throw new ReadableStreamError(
        `upstream SSE line/event exceeds ${MAX_SSE_EVENT_CHARS} bytes`,
        "upstream_event_too_large",
      );
    }
  }

  private processLine(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.charCodeAt(0) === 58 /* ':' */) return; // comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32 /* ' ' */) value = value.slice(1);
    if (field === "data") {
      this.dataChars += value.length + 1;
      this.checkSize(this.dataChars);
      this.dataLines.push(value);
    } else if (field === "event") {
      this.eventType = value.trim();
    }
    // id / retry / unknown fields: ignored.
  }

  private dispatch(): void {
    const eventType = this.eventType;
    const lines = this.dataLines;
    this.eventType = "";
    this.dataLines = [];
    this.dataChars = 0;
    if (lines.length === 0) return;
    const raw = lines.join("\n").trim();
    if (raw === DONE_SENTINEL) {
      this.done = true;
      return;
    }
    const chunk = parseSSEEvent(raw, eventType, this.providerName);
    if (chunk === null) return;
    this.chunkCount++;
    if (chunk.choices.some((c) => c.finishReason)) this.sawFinishReason = true;
    this.out.push(chunk);
  }
}

function errorMessageOf(parsed: unknown): string | undefined {
  if (typeof parsed === "string") return parsed || undefined;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  const errVal = o["error"];
  if (typeof errVal === "string" && errVal) return errVal;
  if (
    typeof errVal === "object" &&
    errVal !== null &&
    typeof (errVal as Record<string, unknown>)["message"] === "string"
  ) {
    return (errVal as Record<string, string>)["message"];
  }
  if (typeof o["message"] === "string" && o["message"]) return o["message"] as string;
  return undefined;
}

function upstreamStreamError(providerName: string, parsed: unknown, fallback: string): ProviderError {
  const message = errorMessageOf(parsed) ?? fallback;
  const errVal =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["error"] : undefined;
  return new ProviderError(providerName, 502, `stream error: ${message}`, {
    origin: "upstream",
    upstream: typeof errVal === "object" && errVal !== null ? (errVal as Record<string, unknown>) : { message },
  });
}

function parseSSEEvent(raw: string, eventType: string, providerName: string): StreamChunk | null {
  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parseFailed = true;
  }

  if (eventType === "error") {
    throw upstreamStreamError(providerName, parseFailed ? raw : parsed, "upstream stream error");
  }
  if (parseFailed) {
    throw new ReadableStreamError("malformed JSON in upstream SSE event", "upstream_invalid_response");
  }

  if (typeof parsed === "object" && parsed !== null && "error" in parsed && !("choices" in parsed)) {
    throw upstreamStreamError(providerName, parsed, "upstream stream error");
  }

  if (typeof parsed !== "object" || parsed === null || !("choices" in parsed)) {
    return null;
  }

  return normalizeChunk(parsed as Record<string, unknown>);
}

/**
 * A 200 response with a JSON body on a stream request (T3-5): an upstream
 * that ignored `stream: true` and answered with a chat.completion becomes
 * one synthetic chunk; an error body becomes an error; anything else is an
 * invalid response.
 */
export function chunkFromJsonBody(text: string, providerName = "upstream"): StreamChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReadableStreamError("upstream returned a non-SSE body on a stream request", "upstream_invalid_response");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ReadableStreamError("upstream returned a non-SSE body on a stream request", "upstream_invalid_response");
  }
  const o = parsed as Record<string, unknown>;
  if ("error" in o && !("choices" in o)) throw upstreamStreamError(providerName, o, "upstream error");
  if (!Array.isArray(o["choices"])) {
    throw new ReadableStreamError("upstream returned a non-SSE body on a stream request", "upstream_invalid_response");
  }
  const choices = (o["choices"] as unknown[]).map((c) => {
    if (typeof c !== "object" || c === null) return c;
    const r = c as Record<string, unknown>;
    return { ...r, delta: r["delta"] ?? r["message"] };
  });
  const chunk = normalizeChunk({ ...o, object: "chat.completion.chunk", choices });
  if (chunk.choices.length === 0 || !chunk.choices.some((c) => c.finishReason)) {
    // Mark the synthetic chunk as complete: the whole answer is here.
    for (const c of chunk.choices) c.finishReason ||= "stop";
  }
  return chunk;
}

/** Read a JSON body returned on a stream request and turn it into one chunk (see chunkFromJsonBody). */
export async function chunkFromJsonResponse(
  response: Response,
  signal: AbortSignal | undefined | null,
  providerName = "upstream",
): Promise<StreamChunk> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw abortError();
    throw new ReadableStreamError(`upstream body read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return chunkFromJsonBody(text, providerName);
}

function normalizeChunk(raw: Record<string, unknown>): StreamChunk {
  const rawChoices = raw["choices"];
  const choices = Array.isArray(rawChoices)
    ? (rawChoices as unknown[]).flatMap((entry, i) => {
        if (typeof entry !== "object" || entry === null) return [];
        const c = entry as Record<string, unknown>;
        const choice: Choice = {
          index: typeof c["index"] === "number" ? (c["index"] as number) : i,
          delta: normalizeDeltaMessage(c["delta"]),
          finishReason: normalizeFinishReason(String(c["finish_reason"] ?? "")),
        };
        // Allow-listed pass-through (T3-11): logprobs and choice-level extras.
        if (c["logprobs"] !== undefined && c["logprobs"] !== null) choice.logprobs = c["logprobs"];
        const extra = pickExtras(c, CHOICE_EXTRA_KEYS);
        if (extra) choice.extra = extra;
        return [choice];
      })
    : [];

  const chunk: StreamChunk = {
    id: String(raw["id"] ?? ""),
    object: String(raw["object"] ?? "chat.completion.chunk"),
    created: typeof raw["created"] === "number" ? (raw["created"] as number) : 0,
    model: String(raw["model"] ?? ""),
    choices,
    usage: normalizeWireUsage(raw["usage"]),
  };
  const extra = pickExtras(raw, RESPONSE_EXTRA_KEYS);
  if (extra) chunk.extra = extra;
  return chunk;
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
    message.toolCalls = (toolCalls as unknown[])
      .map((tc, i) => [tc, i] as const)
      .filter((e): e is readonly [Record<string, unknown>, number] => typeof e[0] === "object" && e[0] !== null)
      .map(([tc, i]) => ({
        id: String(tc["id"] ?? ""),
        type: "function" as const,
        function: {
          name: String((tc["function"] as Record<string, unknown>)?.["name"] ?? ""),
          arguments: String((tc["function"] as Record<string, unknown>)?.["arguments"] ?? ""),
        },
        // Keep the upstream index: later deltas carry only one call at a time,
        // so the array position does not identify which call they extend.
        index: typeof tc["index"] === "number" ? (tc["index"] as number) : i,
      }));
  }

  const extra = pickExtras(r, RESPONSE_MESSAGE_EXTRA_KEYS);
  if (extra) message.extra = extra;
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
