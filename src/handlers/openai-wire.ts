/**
 * OpenAI wire-format translation layer.
 *
 * The gateway works on camelCase internal types (providers/types.ts), while
 * clients speak the OpenAI HTTP wire format (snake_case). This module is the
 * single place where that translation happens:
 *
 *   fromOpenAIWireChatRequest — normalise an incoming request body
 *                               (snake_case → camelCase; camelCase is still
 *                               accepted for backwards compatibility).
 *   toOpenAIWire*             — serialise internal responses / stream chunks
 *                               / embeddings / images into OpenAI wire format.
 *
 * Only well-known keys are translated. Opaque user payloads — tool JSON
 * schemas (`tools[].function.parameters`), `response_format.json_schema.schema`,
 * `logit_bias` token maps — are passed through untouched.
 */

import type {
  ChatCompletionResponse,
  ChatMessage,
  EmbeddingResponse,
  ImageResponse,
  StreamChunk,
  Usage,
} from "../providers/types.js";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Copy `snake` → `camel` on `obj` when the camelCase key is not already set. */
function renameKeys(obj: Json, map: Readonly<Record<string, string>>): Json {
  const out: Json = { ...obj };
  for (const [snake, camel] of Object.entries(map)) {
    if (snake in out) {
      const value = out[snake];
      delete out[snake];
      if (out[camel] === undefined) out[camel] = value;
    }
  }
  return out;
}

// ── Request (wire → internal) ──

const CHAT_REQUEST_KEYS: Readonly<Record<string, string>> = {
  top_p: "topP",
  max_tokens: "maxTokens",
  max_completion_tokens: "maxCompletionTokens",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  logit_bias: "logitBias",
  tool_choice: "toolChoice",
  response_format: "responseFormat",
  top_logprobs: "topLogprobs",
  stream_options: "streamOptions",
  parallel_tool_calls: "parallelToolCalls",
};

const MESSAGE_KEYS: Readonly<Record<string, string>> = {
  tool_calls: "toolCalls",
  tool_call_id: "toolCallId",
};

function normalizeContentPart(part: unknown): unknown {
  if (!isObject(part)) return part;
  return renameKeys(part, { image_url: "imageUrl" });
}

function normalizeMessage(msg: unknown): unknown {
  if (!isObject(msg)) return msg;
  const m = renameKeys(msg, MESSAGE_KEYS);
  // OpenAI clients send `content: null` on assistant tool-call messages.
  if (m["content"] === null) delete m["content"];
  if (Array.isArray(m["content"])) m["content"] = m["content"].map(normalizeContentPart);
  return m;
}

/**
 * Normalise an OpenAI chat-completions request body into the internal
 * camelCase shape expected by the request schema. Unknown keys are left as-is
 * (the schema decides what survives).
 */
export function fromOpenAIWireChatRequest(body: unknown): unknown {
  if (!isObject(body)) return body;
  const out = renameKeys(body, CHAT_REQUEST_KEYS);
  if (Array.isArray(out["messages"])) out["messages"] = out["messages"].map(normalizeMessage);
  if (isObject(out["streamOptions"])) {
    out["streamOptions"] = renameKeys(out["streamOptions"], { include_usage: "includeUsage" });
  }
  if (isObject(out["responseFormat"])) {
    out["responseFormat"] = renameKeys(out["responseFormat"], { json_schema: "jsonSchema" });
  }
  return out;
}

/** Normalise an OpenAI images/generations request body (response_format). */
export function fromOpenAIWireImageRequest(body: unknown): unknown {
  if (!isObject(body)) return body;
  return renameKeys(body, { response_format: "responseFormat" });
}

// ── Response (internal → wire) ──

export function toOpenAIWireUsage(usage: Usage): Json {
  const out: Json = {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
  if (usage.promptTokensDetails) out["prompt_tokens_details"] = usage.promptTokensDetails;
  if (usage.completionTokensDetails) out["completion_tokens_details"] = usage.completionTokensDetails;
  return out;
}

function toWireToolCalls(msg: ChatMessage, isDelta = false): Json[] | undefined {
  if (!msg.toolCalls || msg.toolCalls.length === 0) return undefined;
  return msg.toolCalls.map((tc, i) => {
    let call: Json;
    if (isDelta) {
      // Continuation deltas carry only the argument fragment; omit empty
      // identifiers rather than sending "" for id/name.
      const fn: Json = { arguments: tc.function.arguments };
      if (tc.function.name) fn["name"] = tc.function.name;
      call = { function: fn };
      if (tc.id) {
        call["id"] = tc.id;
        call["type"] = tc.type;
      }
    } else {
      call = {
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      };
    }
    // Streaming tool-call deltas are addressed by index.
    const idx = (tc as { index?: number }).index;
    call["index"] = typeof idx === "number" ? idx : i;
    return call;
  });
}

function toWireMessage(msg: ChatMessage | undefined): Json {
  const m = msg ?? { role: "assistant" as const };
  const out: Json = { role: m.role, content: m.content ?? null };
  if (m.name !== undefined) out["name"] = m.name;
  const toolCalls = toWireToolCalls(m);
  if (toolCalls) {
    out["tool_calls"] = toolCalls.map(({ index: _index, ...rest }) => rest);
  }
  if (m.toolCallId !== undefined) out["tool_call_id"] = m.toolCallId;
  return out;
}

function wireFinishReason(reason: string | null | undefined): string | null {
  return reason ? reason : null;
}

/** Serialise a non-streaming chat completion into the OpenAI wire format. */
export function toOpenAIWireChatResponse(res: ChatCompletionResponse): Json {
  const out: Json = {
    id: res.id,
    object: res.object || "chat.completion",
    created: res.created,
    model: res.model,
    choices: res.choices.map((c) => ({
      index: c.index,
      message: toWireMessage(c.message),
      logprobs: (c as { logprobs?: unknown }).logprobs ?? null,
      finish_reason: wireFinishReason(c.finishReason),
    })),
    usage: toOpenAIWireUsage(res.usage),
  };
  const fingerprint = res.metadata?.["system_fingerprint"];
  if (fingerprint !== undefined) out["system_fingerprint"] = fingerprint;
  return out;
}

/**
 * Stateful per-stream serialiser. OpenAI emits `delta.role` only on the first
 * chunk of each choice and `finish_reason: null` until the final chunk, so the
 * serialiser tracks which choices have already announced their role.
 */
export function createOpenAIWireStreamSerializer(): (chunk: StreamChunk) => Json {
  const roleSent = new Set<number>();
  return (chunk: StreamChunk): Json => {
    const out: Json = {
      id: chunk.id,
      object: chunk.object || "chat.completion.chunk",
      created: chunk.created,
      model: chunk.model,
      choices: chunk.choices.map((c) => {
        const src = c.delta ?? c.message;
        const delta: Json = {};
        if (src) {
          if (!roleSent.has(c.index)) {
            delta["role"] = src.role ?? "assistant";
            roleSent.add(c.index);
          }
          if (src.content !== undefined) delta["content"] = src.content;
          const toolCalls = toWireToolCalls(src, true);
          if (toolCalls) delta["tool_calls"] = toolCalls;
        }
        return {
          index: c.index,
          delta,
          logprobs: (c as { logprobs?: unknown }).logprobs ?? null,
          finish_reason: wireFinishReason(c.finishReason),
        };
      }),
    };
    if (chunk.usage) out["usage"] = toOpenAIWireUsage(chunk.usage);
    return out;
  };
}

/** Serialise an embeddings response into the OpenAI wire format. */
export function toOpenAIWireEmbeddingResponse(res: EmbeddingResponse): Json {
  return {
    object: res.object || "list",
    data: res.data.map((d) => ({ object: d.object || "embedding", embedding: d.embedding, index: d.index })),
    model: res.model,
    usage: {
      prompt_tokens: res.usage.promptTokens,
      total_tokens: res.usage.totalTokens,
    },
  };
}

/** Serialise an image generation response into the OpenAI wire format. */
export function toOpenAIWireImageResponse(res: ImageResponse): Json {
  return {
    created: res.created,
    data: res.data.map((d) => {
      const item: Json = {};
      if (d.url !== undefined) item["url"] = d.url;
      if (d.b64Json !== undefined) item["b64_json"] = d.b64Json;
      if (d.revisedPrompt !== undefined) item["revised_prompt"] = d.revisedPrompt;
      return item;
    }),
  };
}
