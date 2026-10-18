/**
 * Universal OpenAI-compatible provider adapter.
 *
 * A single implementation that drives 22+ providers via their OpenAI-compatible
 * HTTP APIs. Handles request serialisation, response parsing, SSE streaming,
 * error extraction, and finish-reason normalisation.
 */

import type {
  IProvider,
  IStreamProvider,
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  Choice,
  EmbeddingRequest,
  EmbeddingResponse,
  IEmbeddingProvider,
  IImageProvider,
  ImageRequest,
  ImageResponse,
  ModelInfo,
  StreamChunk,
  ToolChoice,
} from "./types.js";
import type { CompatibilityConfig } from "../config/types.js";
import { enforceUnsupportedParams } from "./capabilities.js";
import { chunkFromJsonResponse, parseSSEStream } from "./sse-parser.js";
import { extractForwardableHeaders } from "./response-headers.js";
import {
  CHOICE_EXTRA_KEYS,
  RESPONSE_EXTRA_KEYS,
  RESPONSE_MESSAGE_EXTRA_KEYS,
  applyExtras,
  normalizeWireUsage,
  pickExtras,
} from "./wire-extras.js";

export interface OpenAiCompatOptions {
  /** Target name (errors, metrics, served-by). */
  name: string;
  /**
   * Provider preset id (`target.provider`, e.g. "mistral") used for the
   * capability matrix. Defaults to `name` for direct embedded use.
   */
  providerType?: string;
  baseURL: string;
  apiKey: string;
  models?: readonly string[];
  bodyTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
  extraResponseFields?: readonly string[];
  extraHeaders?: Record<string, string>;
  compatibility?: CompatibilityConfig["onUnsupportedParam"];
}

interface OpenAiErrorResponse {
  error: {
    message: string;
    type?: string;
    code?: string;
  };
}

export type OpenAICompatProvider = IProvider & IStreamProvider & IEmbeddingProvider & IImageProvider;

export function createOpenAICompatProvider(opts: OpenAiCompatOptions): OpenAICompatProvider {
  const baseURL = opts.baseURL.replace(/\/+$/, "");
  const compatibilityMode = opts.compatibility ?? "warn";
  const capabilityKey = opts.providerType ?? opts.name;
  const extraHeaders = opts.extraHeaders ?? {};
  const modelList: readonly ModelInfo[] = (opts.models ?? []).map((id) => ({
    id,
    ownedBy: opts.name,
  }));

  /** POST a JSON body to `${baseURL}${path}` and return the parsed JSON (throws ProviderError). */
  async function postJSON(ctx: RequestContext, path: string, body: Record<string, unknown>): Promise<{ raw: Record<string, unknown>; response: Response }> {
    let response: Response;
    try {
      response = await fetch(`${baseURL}${path}`, {
        method: "POST",
        headers: buildHeaders(opts.apiKey, extraHeaders),
        body: JSON.stringify(body),
        signal: ctx.signal ?? null,
      });
    } catch (err) {
      throw new ProviderError(
        opts.name,
        0,
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw await buildErrorFromResponse(opts.name, response, response.headers.get("Retry-After"));
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new ProviderError(opts.name, 502, "invalid JSON in upstream response", { origin: "invalid_body" });
    }
    if (typeof raw !== "object" || raw === null) {
      throw new ProviderError(opts.name, 502, "unexpected upstream response shape", { origin: "invalid_body" });
    }
    return { raw: raw as Record<string, unknown>, response };
  }

  const provider: OpenAICompatProvider = {
    name: opts.name,

    async embed(ctx: RequestContext, req: EmbeddingRequest): Promise<EmbeddingResponse> {
      const body: Record<string, unknown> = { model: req.model, input: req.input };
      setIfDefined(body, "dimensions", req.dimensions);
      setIfDefined(body, "encoding_format", req.encodingFormat);
      setIfDefined(body, "user", req.user);
      const { raw } = await postJSON(ctx, "/embeddings", body);
      return normalizeEmbeddingResponse(opts.name, req.model, raw);
    },

    async generateImage(ctx: RequestContext, req: ImageRequest): Promise<ImageResponse> {
      const body: Record<string, unknown> = { model: req.model, prompt: req.prompt };
      setIfDefined(body, "n", req.n);
      setIfDefined(body, "size", req.size);
      setIfDefined(body, "response_format", req.responseFormat);
      setIfDefined(body, "quality", req.quality);
      setIfDefined(body, "style", req.style);
      setIfDefined(body, "user", req.user);
      const { raw } = await postJSON(ctx, "/images/generations", body);
      return normalizeImageResponse(opts.name, raw);
    },

    async complete(ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const enforced = enforceUnsupportedParams(capabilityKey, req, compatibilityMode, opts.name);
      if (enforced.action === "rejected") {
        throw new ProviderError(opts.name, 400, enforced.reason.replace(`${opts.name} does not support`, "Unsupported parameters for this model"));
      }
      const request = enforced.request;

      const body = buildRequestBody(request);
      const transformed = opts.bodyTransform ? opts.bodyTransform(body) : body;

      const url = `${baseURL}/chat/completions`;
      const headers = buildHeaders(opts.apiKey, extraHeaders);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformed),
          signal: ctx.signal ?? null,
        });
      } catch (err) {
        // A client/caller abort is not an upstream failure: rethrow as-is.
        if (isAbortError(err) || ctx.signal?.aborted) throw abortErrorFrom(err);
        throw new ProviderError(
          opts.name,
          0,
          `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        throw await buildErrorFromResponse(opts.name, response, retryAfter);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch (err) {
        if (isAbortError(err) || ctx.signal?.aborted) throw abortErrorFrom(err);
        throw new ProviderError(opts.name, 502, "invalid JSON in upstream response", { origin: "invalid_body" });
      }
      if (!isValidChatBody(raw)) {
        throw new ProviderError(opts.name, 502, "unexpected upstream response shape", { origin: "invalid_body" });
      }
      const normalized = normalizeResponse(opts.name, raw, opts.extraResponseFields);
      const upstreamHeaders = extractForwardableHeaders(response.headers);
      if (upstreamHeaders !== undefined) {
        normalized.upstreamHeaders = upstreamHeaders;
      }
      return normalized;
    },

    async *completeStream(
      ctx: RequestContext,
      req: ChatCompletionRequest,
    ): AsyncGenerator<StreamChunk> {
      const enforced = enforceUnsupportedParams(capabilityKey, req, compatibilityMode, opts.name);
      if (enforced.action === "rejected") {
        throw new ProviderError(opts.name, 400, enforced.reason.replace(`${opts.name} does not support`, "Unsupported parameters for this model"));
      }

      const streamReq = { ...enforced.request, stream: true as const };
      const body = buildRequestBody(streamReq);
      const transformed = opts.bodyTransform ? opts.bodyTransform(body) : body;

      const url = `${baseURL}/chat/completions`;
      const headers = buildHeaders(opts.apiKey, extraHeaders);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformed),
          signal: ctx.signal ?? null,
        });
      } catch (err) {
        // A client/caller abort is not an upstream failure: rethrow as-is.
        if (isAbortError(err) || ctx.signal?.aborted) throw abortErrorFrom(err);
        throw new ProviderError(
          opts.name,
          0,
          `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        throw await buildErrorFromResponse(opts.name, response, retryAfter);
      }

      if (!response.body) {
        throw new ProviderError(opts.name, 0, "response body is null");
      }

      // No response object exists on the streaming path, so forwardable
      // upstream headers are published back through the request context.
      const upstreamHeaders = extractForwardableHeaders(response.headers);
      if (upstreamHeaders !== undefined) {
        ctx.upstreamHeaders = upstreamHeaders;
      }

      // A 200 JSON body on a stream request (an error, or an upstream that
      // ignored stream:true) must not become an empty "successful" stream (T3-5).
      if (/\bjson\b/i.test(response.headers.get("content-type") ?? "")) {
        yield await chunkFromJsonResponse(response, ctx.signal, opts.name);
        return;
      }

      yield* parseSSEStream(response.body, ctx.signal, opts.name);
    },

    supportedModels(): string[] {
      return modelList.map((m) => m.id);
    },

    supportsModel(model: string): boolean {
      return modelList.some((m) => m.id === model);
    },

    models(): ModelInfo[] {
      return [...modelList];
    },
  };

  return provider;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function buildRequestBody(req: ChatCompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(serializeMessage),
  };

  setIfDefined(body, "temperature", req.temperature);
  setIfDefined(body, "top_p", req.topP);
  setIfDefined(body, "n", req.n);
  setIfDefined(body, "stop", req.stop);
  setIfDefined(body, "max_tokens", req.maxTokens);
  setIfDefined(body, "max_completion_tokens", req.maxCompletionTokens);
  setIfDefined(body, "presence_penalty", req.presencePenalty);
  setIfDefined(body, "frequency_penalty", req.frequencyPenalty);
  setIfDefined(body, "logit_bias", req.logitBias);
  setIfDefined(body, "user", req.user);
  setIfDefined(body, "seed", req.seed);
  setIfDefined(body, "logprobs", req.logprobs);
  setIfDefined(body, "top_logprobs", req.topLogprobs);
  setIfDefined(body, "parallel_tool_calls", req.parallelToolCalls);

  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => {
      const fn: Record<string, unknown> = { name: t.function.name };
      if (t.function.description !== undefined) fn["description"] = t.function.description;
      if (t.function.parameters !== undefined) fn["parameters"] = t.function.parameters;
      if (t.function.strict !== undefined) fn["strict"] = t.function.strict;
      return { type: t.type, function: fn };
    });
  }

  if (req.toolChoice !== undefined) {
    body["tool_choice"] = serializeToolChoice(req.toolChoice);
  }

  if (req.responseFormat) {
    const rf: Record<string, unknown> = { type: req.responseFormat.type };
    if (req.responseFormat.jsonSchema !== undefined) rf["json_schema"] = req.responseFormat.jsonSchema;
    body["response_format"] = rf;
  }

  if (req.streamOptions) {
    body["stream_options"] = { include_usage: req.streamOptions.includeUsage };
  }

  if (req.stream !== undefined) {
    body["stream"] = req.stream;
  }

  // Allow-listed pass-through fields (reasoning_effort, store, top_k …); typed fields win.
  return applyExtras(body, req.extra);
}

function serializeMessage(msg: ChatMessage): Record<string, unknown> {
  const m: Record<string, unknown> = { role: msg.role };

  if (typeof msg.content === "string") {
    m["content"] = msg.content;
  } else if (Array.isArray(msg.content)) {
    m["content"] = msg.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text ?? "" };
      const img: Record<string, unknown> = { url: part.imageUrl?.url ?? "" };
      if (part.imageUrl?.detail) img["detail"] = part.imageUrl.detail;
      return { type: "image_url", image_url: img };
    });
  }

  if (msg.name !== undefined) m["name"] = msg.name;

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    m["tool_calls"] = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  }

  if (msg.toolCallId !== undefined) m["tool_call_id"] = msg.toolCallId;

  return applyExtras(m, msg.extra);
}

function serializeToolChoice(tc: ToolChoice): unknown {
  if (typeof tc === "string") return tc;
  return { type: "function", function: { name: tc.function.name } };
}

// ---------------------------------------------------------------------------
// Response normalisation

/** A chat completion body we can normalise: an object whose `choices` (if any) are all objects. */
function isValidChatBody(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const choices = (raw as Record<string, unknown>)["choices"];
  if (choices === undefined) return true;
  return Array.isArray(choices) && choices.every((c) => typeof c === "object" && c !== null && !Array.isArray(c));
}
// ---------------------------------------------------------------------------

function normalizeResponse(
  providerName: string,
  raw: Record<string, unknown>,
  extraFields?: readonly string[],
): ChatCompletionResponse {
  const choices: Choice[] = [];

  const rawChoices = raw["choices"];
  if (Array.isArray(rawChoices)) {
    for (const c of rawChoices as Record<string, unknown>[]) {
      const choice: Choice = {
        index: typeof c["index"] === "number" ? (c["index"] as number) : 0,
        message: normalizeChoiceMessage(c["message"]),
        finishReason: normalizeFinishReason(String(c["finish_reason"] ?? "")),
      };
      if (c["logprobs"] !== undefined && c["logprobs"] !== null) choice.logprobs = c["logprobs"];
      const choiceExtra = pickExtras(c, CHOICE_EXTRA_KEYS);
      if (choiceExtra) choice.extra = choiceExtra;
      choices.push(choice);
    }
  }

  const metadata: Record<string, unknown> = {};
  if (extraFields) {
    for (const field of extraFields) {
      if (field in raw) {
        metadata[field] = raw[field];
      }
    }
  }

  const model = String(raw["model"] ?? "");
  const extra = pickExtras(raw, extraFields ? [...RESPONSE_EXTRA_KEYS, ...extraFields] : RESPONSE_EXTRA_KEYS);

  const response: ChatCompletionResponse = {
    id: String(raw["id"] ?? ""),
    object: String(raw["object"] ?? "chat.completion"),
    created: typeof raw["created"] === "number" ? (raw["created"] as number) : 0,
    model,
    provider: providerName,
    choices,
    usage: normalizeWireUsage(raw["usage"]) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
  if (extra) response.extra = extra;
  return response;
}

function normalizeEmbeddingResponse(
  providerName: string,
  requestedModel: string,
  raw: Record<string, unknown>,
): EmbeddingResponse {
  const rawData = Array.isArray(raw["data"]) ? (raw["data"] as Record<string, unknown>[]) : [];
  const usageRaw = raw["usage"] as Record<string, number> | undefined;
  const promptTokens = usageRaw?.["prompt_tokens"] ?? 0;
  return {
    object: String(raw["object"] ?? "list"),
    model: String(raw["model"] ?? requestedModel),
    provider: providerName,
    data: rawData.map((d, i) => ({
      object: String(d["object"] ?? "embedding"),
      // encoding_format "base64": the embedding is a base64 string, passed through as-is.
      embedding: Array.isArray(d["embedding"]) ? (d["embedding"] as number[]) : typeof d["embedding"] === "string" ? d["embedding"] : [],
      index: typeof d["index"] === "number" ? (d["index"] as number) : i,
    })),
    usage: {
      promptTokens,
      completionTokens: 0,
      totalTokens: usageRaw?.["total_tokens"] ?? promptTokens,
    },
  };
}

function normalizeImageResponse(providerName: string, raw: Record<string, unknown>): ImageResponse {
  const rawData = Array.isArray(raw["data"]) ? (raw["data"] as Record<string, unknown>[]) : [];
  return {
    created: typeof raw["created"] === "number" ? (raw["created"] as number) : Math.floor(Date.now() / 1000),
    provider: providerName,
    data: rawData.map((d) => {
      const item: { url?: string; b64Json?: string; revisedPrompt?: string } = {};
      if (typeof d["url"] === "string") item.url = d["url"];
      if (typeof d["b64_json"] === "string") item.b64Json = d["b64_json"];
      if (typeof d["revised_prompt"] === "string") item.revisedPrompt = d["revised_prompt"];
      return item;
    }),
  };
}

function normalizeChoiceMessage(raw: unknown): Choice["message"] {
  if (typeof raw !== "object" || raw === null) return { role: "assistant" };
  const m = raw as Record<string, unknown>;

  const message: ChatMessage = {
    role: narrowRole(String(m["role"] ?? "assistant")),
  };

  const content = m["content"];
  if (typeof content === "string") {
    message.content = content;
  } else if (content === null) {
    message.content = undefined;
  }

  const toolCalls = m["tool_calls"];
  if (Array.isArray(toolCalls)) {
    message.toolCalls = (toolCalls as Record<string, unknown>[]).map((tc) => {
      const fn = tc["function"] as Record<string, unknown> | undefined;
      return {
        id: String(tc["id"] ?? ""),
        type: "function" as const,
        function: {
          name: String(fn?.["name"] ?? ""),
          arguments: String(fn?.["arguments"] ?? ""),
        },
      };
    });
  }

  const extra = pickExtras(m, RESPONSE_MESSAGE_EXTRA_KEYS);
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
    tool_calls: "tool_calls",
  };
  return map[raw] ?? raw;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function buildHeaders(apiKey: string, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

async function buildErrorFromResponse(
  providerName: string,
  response: Response,
  retryAfter: string | null,
): Promise<ProviderError> {
  let message = `HTTP ${response.status}`;
  let upstream: UpstreamErrorBody | undefined;

  try {
    const body = (await response.json()) as Partial<OpenAiErrorResponse>;
    if (body?.error && typeof body.error === "object") {
      upstream = body.error as UpstreamErrorBody;
      if (typeof body.error.message === "string" && body.error.message) message = body.error.message;
    } else if (typeof (body as { error?: unknown })?.error === "string") {
      message = (body as unknown as { error: string }).error;
      upstream = { message };
    }
  } catch {
    const text = response.statusText;
    if (text) message = text;
  }

  const err = new ProviderError(providerName, response.status, message, { origin: "upstream", upstream });
  if (retryAfter) {
    err.retryAfter = retryAfter;
  }
  return err;
}

function isAbortError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}

function abortErrorFrom(err: unknown): unknown {
  return isAbortError(err) ? err : new DOMException("Aborted", "AbortError");
}

/** The OpenAI-shaped `error` object of an upstream error response, when it had one. */
export interface UpstreamErrorBody {
  readonly message?: unknown;
  readonly type?: unknown;
  readonly code?: unknown;
  readonly param?: unknown;
}

/**
 * Where a ProviderError came from:
 *  - "upstream": an HTTP error response (or SSE error event) from the target;
 *  - "transport": the request never got a response (DNS, refused, RST, TLS…);
 *  - "invalid_body": a 2xx response whose body could not be used;
 *  - "local": raised by the gateway before / instead of calling upstream.
 */
export type ProviderErrorOrigin = "upstream" | "transport" | "invalid_body" | "local";

export class ProviderError extends Error {
  override name = "ProviderError";
  /** Message without the "[target] " prefix (never contains the target name by construction). */
  public readonly detail: string;
  public readonly origin: ProviderErrorOrigin;
  public readonly upstream: UpstreamErrorBody | undefined;

  constructor(
    public readonly provider: string,
    public readonly statusCode: number,
    message: string,
    opts: { origin?: ProviderErrorOrigin; upstream?: UpstreamErrorBody } = {},
  ) {
    super(`[${provider}] ${message}`);
    this.detail = message;
    this.origin = opts.origin ?? (statusCode === 0 ? "transport" : "local");
    this.upstream = opts.upstream;
  }

  public retryAfter?: string;
}
