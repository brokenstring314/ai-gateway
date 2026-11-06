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
import { type KeyPool, keyErrorText, type Lease, NoUsableKeyError } from "../routing/key-pool.js";
import { enforceUnsupportedParams, ProviderCapability, supportsCapability } from "./capabilities.js";
import { chunkFromJsonBody, parseSSEStream } from "./sse-parser.js";
import {
  DEFAULT_UPSTREAM_RESPONSE_LIMITS,
  readTextBounded,
  type UpstreamResponseLimits,
  UpstreamResponseTooLargeError,
} from "./bounded-body.js";
import { extractForwardableHeaders } from "./response-headers.js";
import { scrubRecord, scrubSecrets } from "../security/secret-scrub.js";
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
  /** The upstream key when no key pool is given. */
  apiKey: string;
  /**
   * Several upstream keys (0.3.0 P4): one is leased per upstream call; a
   * 429 / 402 answer cools that key down (402: softly; disabled only after
   * repeated account-level 402s), a 401 disables it, and the call is repeated
   * with the next usable key before the attempt counts as failed.
   */
  keys?: KeyPool;
  /** fetch to use (default: the global fetch at call time). */
  fetchImpl?: typeof fetch;
  models?: readonly string[];
  bodyTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
  extraResponseFields?: readonly string[];
  extraHeaders?: Record<string, string>;
  compatibility?: CompatibilityConfig["onUnsupportedParam"];
  /**
   * Ceilings for reading upstream bodies, counted after decompression
   * (FS-1): successful non-streaming bodies (default 32 MiB) and error
   * bodies (default 64 KiB).
   */
  responseLimits?: UpstreamResponseLimits;
}

interface OpenAiErrorResponse {
  error: {
    message: string;
    type?: string;
    code?: string;
  };
}

export type OpenAICompatProvider = IProvider &
  IStreamProvider &
  IEmbeddingProvider &
  IImageProvider & {
    /** The channel's key pool, when it has one (executor: skip a channel without a usable key). */
    readonly keyPool?: KeyPool;
  };

/** Upstream statuses that take one key out (cooldown / disable, see routing/key-pool.ts) and move on to the next key. */
const KEY_STATUSES: ReadonlySet<number> = new Set([401, 402, 429]);

export function createOpenAICompatProvider(opts: OpenAiCompatOptions): OpenAICompatProvider {
  const baseURL = opts.baseURL.replace(/\/+$/, "");
  const compatibilityMode = opts.compatibility ?? "warn";
  const capabilityKey = opts.providerType ?? opts.name;
  const extraHeaders = opts.extraHeaders ?? {};
  const limits = opts.responseLimits ?? DEFAULT_UPSTREAM_RESPONSE_LIMITS;
  const modelList: readonly ModelInfo[] = (opts.models ?? []).map((id) => ({
    id,
    ownedBy: opts.name,
  }));

  /**
   * POST `payload` to `${baseURL}${path}` with a leased key; on 401/402/429
   * the key is reported to the pool (a success too, ending a run of 402s) and the call repeated with the next
   * usable key. Returns the first OK response; throws ProviderError (the last
   * upstream error) or an AbortError.
   */
  /** Every upstream key of this channel: scrubbed out of upstream error text (red team 2026-11-05 P3). */
  function channelSecrets(): string[] {
    return opts.keys ? opts.keys.secretValues() : opts.apiKey ? [opts.apiKey] : [];
  }

  /** Re-throw stream errors (SSE `error` events, a JSON error body) with the channel's keys scrubbed. */
  async function* scrubbedStream(source: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    try {
      yield* source;
    } catch (err) {
      throw err instanceof ProviderError ? scrubProviderError(err, channelSecrets()) : err;
    }
  }

  async function send(ctx: RequestContext, path: string, payload: string): Promise<Response> {
    const pool = opts.keys;
    const tried = new Set<string>();
    let lastError: ProviderError | undefined;
    while (true) {
      let lease: Lease;
      if (pool) {
        try {
          lease = pool.acquire(tried);
        } catch (err) {
          if (err instanceof NoUsableKeyError && lastError) throw lastError;
          throw err;
        }
      } else {
        lease = { id: "", key: opts.apiKey };
      }
      let response: Response;
      try {
        const doFetch = opts.fetchImpl ?? globalThis.fetch;
        response = await doFetch(`${baseURL}${path}`, {
          method: "POST",
          headers: buildHeaders(lease.key, extraHeaders),
          body: payload,
          signal: ctx.signal ?? null,
        });
      } catch (err) {
        // A client/caller abort is not an upstream failure: rethrow as-is.
        if (isAbortError(err) || ctx.signal?.aborted) throw abortErrorFrom(err);
        throw new ProviderError(opts.name, 0, `fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (response.ok) {
        if (pool) pool.reportSuccess(lease.id);
        return response;
      }
      const retryAfter = response.headers.get("Retry-After");
      // The channel's own keys never travel on in upstream error text (P3).
      const err = scrubProviderError(
        await buildErrorFromResponse(opts.name, response, retryAfter, limits.maxErrorBodyBytes, ctx.signal),
        channelSecrets(),
      );
      if (pool && KEY_STATUSES.has(response.status)) {
        pool.report(lease.id, response.status, retryAfter, keyErrorText(response.status, err.detail, lease.key));
        tried.add(lease.id);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  /**
   * A successful upstream body as text, read with the response limit (FS-1):
   * past it the upstream transfer is cancelled and a 502
   * `upstream_response_too_large` ProviderError is thrown.
   */
  async function readBodyText(ctx: RequestContext, response: Response): Promise<string> {
    try {
      return await readTextBounded(response, limits.maxResponseBytes);
    } catch (err) {
      if (err instanceof UpstreamResponseTooLargeError) {
        throw new ProviderError(opts.name, 502, err.message, { origin: "too_large" });
      }
      if (isAbortError(err) || ctx.signal?.aborted) throw abortErrorFrom(err);
      throw new ProviderError(opts.name, 502, "upstream body read failed", { origin: "invalid_body" });
    }
  }

  /** `readBodyText` parsed as JSON (invalid JSON → 502 invalid_body). */
  async function readJsonBody(ctx: RequestContext, response: Response): Promise<unknown> {
    const text = await readBodyText(ctx, response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError(opts.name, 502, "invalid JSON in upstream response", { origin: "invalid_body" });
    }
  }

  /** POST a JSON body to `${baseURL}${path}` and return the parsed JSON (throws ProviderError). */
  async function postJSON(
    ctx: RequestContext,
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ raw: Record<string, unknown>; response: Response }> {
    const response = await send(ctx, path, JSON.stringify(body));
    const raw = await readJsonBody(ctx, response);
    if (typeof raw !== "object" || raw === null) {
      throw new ProviderError(opts.name, 502, "unexpected upstream response shape", { origin: "invalid_body" });
    }
    return { raw: raw as Record<string, unknown>, response };
  }

  const provider: OpenAICompatProvider = {
    name: opts.name,
    ...(opts.keys ? { keyPool: opts.keys } : {}),

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
        throw new ProviderError(
          opts.name,
          400,
          enforced.reason.replace(`${opts.name} does not support`, "Unsupported parameters for this model"),
        );
      }
      const request = enforced.request;

      const body = buildRequestBody(request);
      const transformed = opts.bodyTransform ? opts.bodyTransform(body) : body;

      const response = await send(ctx, "/chat/completions", JSON.stringify(transformed));

      const raw = await readJsonBody(ctx, response);
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

    async *completeStream(ctx: RequestContext, req: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
      const enforced = enforceUnsupportedParams(capabilityKey, req, compatibilityMode, opts.name);
      if (enforced.action === "rejected") {
        throw new ProviderError(
          opts.name,
          400,
          enforced.reason.replace(`${opts.name} does not support`, "Unsupported parameters for this model"),
        );
      }

      const streamReq = { ...enforced.request, stream: true as const };
      const body = buildRequestBody(streamReq);
      // Always ask for the usage chunk where the provider supports
      // stream_options, so quotas / TPM / usage stats meter the upstream's
      // real token counts instead of an estimate. When the client did not ask
      // for it, core/chat-stream.ts keeps the usage-only chunk off its stream.
      if (supportsCapability(capabilityKey, ProviderCapability.StreamOptions)) {
        const so = isPlainObject(body["stream_options"]) ? body["stream_options"] : {};
        body["stream_options"] = { ...so, include_usage: true };
      }
      const transformed = opts.bodyTransform ? opts.bodyTransform(body) : body;

      const response = await send(ctx, "/chat/completions", JSON.stringify(transformed));

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
        yield* scrubbedStream(
          (async function* () {
            yield chunkFromJsonBody(await readBodyText(ctx, response), opts.name);
          })(),
        );
        return;
      }

      yield* scrubbedStream(parseSSEStream(response.body, ctx.signal, opts.name));
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
      if (part.type !== "image_url") return part.raw ?? { type: part.type };
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
      embedding: Array.isArray(d["embedding"])
        ? (d["embedding"] as number[])
        : typeof d["embedding"] === "string"
          ? d["embedding"]
          : [],
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
  maxBodyBytes: number,
  signal: AbortSignal | null | undefined,
): Promise<ProviderError> {
  let message = `HTTP ${response.status}`;
  let upstream: UpstreamErrorBody | undefined;

  // Bounded (FS-1): an error body is read for its message only, at most
  // maxBodyBytes after decompression; a larger one keeps the status with a
  // generic message, so key cooldown / failover still see the real status.
  let text: string | undefined;
  try {
    text = await readTextBounded(response, maxBodyBytes);
  } catch (err) {
    if (err instanceof UpstreamResponseTooLargeError) message = `HTTP ${response.status} (error body too large)`;
    else if (signal?.aborted || isAbortError(err)) throw abortErrorFrom(err);
  }
  try {
    if (text === undefined) throw new Error("no body");
    const body = JSON.parse(text) as Partial<OpenAiErrorResponse>;
    if (body?.error && typeof body.error === "object") {
      upstream = body.error as UpstreamErrorBody;
      if (typeof body.error.message === "string" && body.error.message) message = body.error.message;
    } else if (typeof (body as { error?: unknown })?.error === "string") {
      message = (body as unknown as { error: string }).error;
      upstream = { message };
    }
  } catch {
    if (text !== undefined && response.statusText) message = response.statusText;
  }

  const err = new ProviderError(providerName, response.status, message, { origin: "upstream", upstream });
  if (retryAfter) {
    err.retryAfter = retryAfter;
  }
  return err;
}

/**
 * `err` with the given secrets and anything key-shaped removed from its
 * message and upstream error body (red team 2026-11-05 P3); the same error
 * object when nothing changed.
 */
export function scrubProviderError(err: ProviderError, secrets: readonly string[]): ProviderError {
  const detail = scrubSecrets(err.detail, secrets);
  const upstream = err.upstream ? scrubRecord(err.upstream as Record<string, unknown>, secrets) : undefined;
  const upstreamChanged =
    err.upstream !== undefined &&
    Object.entries(err.upstream).some(([k, v]) => (upstream as Record<string, unknown>)[k] !== v);
  if (detail === err.detail && !upstreamChanged) return err;
  const out = new ProviderError(err.provider, err.statusCode, detail, {
    origin: err.origin,
    ...(upstream !== undefined ? { upstream } : {}),
  });
  if (err.retryAfter !== undefined) out.retryAfter = err.retryAfter;
  return out;
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
 *  - "too_large": a 2xx body over the response limit (FS-1; 502 upstream_response_too_large);
 *  - "local": raised by the gateway before / instead of calling upstream.
 */
export type ProviderErrorOrigin = "upstream" | "transport" | "invalid_body" | "too_large" | "local";

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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
