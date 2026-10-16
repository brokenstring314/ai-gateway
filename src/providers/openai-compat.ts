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
  ModelInfo,
  StreamChunk,
  ToolChoice,
} from "./types.js";
import type { CompatibilityConfig } from "../config/types.js";
import { enforceUnsupportedParams } from "./capabilities.js";
import { parseSSEStream } from "./sse-parser.js";
import { extractForwardableHeaders } from "./response-headers.js";

export interface OpenAiCompatOptions {
  name: string;
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

export function createOpenAICompatProvider(opts: OpenAiCompatOptions): IProvider & IStreamProvider {
  const baseURL = opts.baseURL.replace(/\/+$/, "");
  const compatibilityMode = opts.compatibility ?? "warn";
  const extraHeaders = opts.extraHeaders ?? {};
  const modelList: readonly ModelInfo[] = (opts.models ?? []).map((id) => ({
    id,
    ownedBy: opts.name,
  }));

  const provider: IProvider & IStreamProvider = {
    name: opts.name,

    async complete(ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const enforced = enforceUnsupportedParams(opts.name, req, compatibilityMode);
      if (enforced.action === "rejected") {
        throw new ProviderError(opts.name, 400, enforced.reason);
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

      const raw = (await response.json()) as Record<string, unknown>;
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
      const enforced = enforceUnsupportedParams(opts.name, req, compatibilityMode);
      if (enforced.action === "rejected") {
        throw new ProviderError(opts.name, 400, enforced.reason);
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

  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => {
      const fn: Record<string, unknown> = { name: t.function.name };
      if (t.function.description !== undefined) fn["description"] = t.function.description;
      if (t.function.parameters !== undefined) fn["parameters"] = t.function.parameters;
      return { type: t.type, function: fn };
    });
  }

  if (req.toolChoice !== undefined) {
    body["tool_choice"] = serializeToolChoice(req.toolChoice);
  }

  if (req.responseFormat) {
    body["response_format"] = { type: req.responseFormat.type };
  }

  if (req.streamOptions) {
    body["stream_options"] = { include_usage: req.streamOptions.includeUsage };
  }

  if (req.stream !== undefined) {
    body["stream"] = req.stream;
  }

  return body;
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

  return m;
}

function serializeToolChoice(tc: ToolChoice): unknown {
  if (typeof tc === "string") return tc;
  return { type: "function", function: { name: tc.function.name } };
}

// ---------------------------------------------------------------------------
// Response normalisation
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
      choices.push({
        index: typeof c["index"] === "number" ? (c["index"] as number) : 0,
        message: normalizeChoiceMessage(c["message"]),
        finishReason: normalizeFinishReason(String(c["finish_reason"] ?? "")),
      });
    }
  }

  const usageRaw = raw["usage"] as Record<string, number> | undefined;

  const metadata: Record<string, unknown> = {};
  if (extraFields) {
    for (const field of extraFields) {
      if (field in raw) {
        metadata[field] = raw[field];
      }
    }
  }

  const model = String(raw["model"] ?? "");

  return {
    id: String(raw["id"] ?? ""),
    object: String(raw["object"] ?? "chat.completion"),
    created: typeof raw["created"] === "number" ? (raw["created"] as number) : 0,
    model,
    provider: providerName,
    choices,
    usage: usageRaw
      ? {
          promptTokens: usageRaw["prompt_tokens"] ?? 0,
          completionTokens: usageRaw["completion_tokens"] ?? 0,
          totalTokens: usageRaw["total_tokens"] ?? 0,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
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

  try {
    const body = (await response.json()) as Partial<OpenAiErrorResponse>;
    if (body?.error?.message) {
      message = body.error.message;
    }
  } catch {
    const text = response.statusText;
    if (text) message = text;
  }

  const err = new ProviderError(providerName, response.status, message);
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

export class ProviderError extends Error {
  override name = "ProviderError";

  constructor(
    public readonly provider: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(`[${provider}] ${message}`);
  }

  public retryAfter?: string;
}
