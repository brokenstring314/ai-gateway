/**
 * Provider interfaces — the core contracts for all LLM provider implementations.
 * Mirrors the Go project's providers/core/contracts.go but OpenAI-compatible only.
 */

/** Core provider interface — every provider must implement this. */
export interface IProvider {
  readonly name: string;
  complete(ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  supportedModels(): string[];
  supportsModel(model: string): boolean;
  models(): ModelInfo[];
}

/** Optional streaming interface for providers that support SSE. */
export interface IStreamProvider extends IProvider {
  completeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncIterable<StreamChunk>;
}

/** Optional embedding interface. */
export interface IEmbeddingProvider extends IProvider {
  embed(ctx: RequestContext, req: EmbeddingRequest): Promise<EmbeddingResponse>;
}

/** Optional image generation interface. */
export interface IImageProvider extends IProvider {
  generateImage(ctx: RequestContext, req: ImageRequest): Promise<ImageResponse>;
}

/** Read-only view over registered providers. */
export interface IProviderSource {
  get(name: string): IProvider | undefined;
  list(): string[];
  allModels(): readonly ModelInfo[];
  findByModel(model: string): IProvider | undefined;
}

// --- Data types ---

export interface RequestContext {
  signal?: AbortSignal;
  traceId?: string;
  metadata: Record<string, unknown>;
  /**
   * Forwardable upstream HTTP response headers published by the provider
   * after its upstream call (whitelist-filtered; hop-by-hop excluded).
   * Streaming requests have no response object, so headers travel back to
   * the handler through the context instead.
   */
  upstreamHeaders?: Readonly<Record<string, string>>;
}

export interface ModelInfo {
  id: string;
  ownedBy: string;
  created?: number;
}

// --- Chat Completion ---

export interface ChatCompletionRequest {
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  topP?: number;
  n?: number;
  stream?: boolean;
  stop?: string | readonly string[];
  maxTokens?: number;
  maxCompletionTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  logitBias?: Record<string, number>;
  user?: string;
  seed?: number;
  tools?: readonly ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  logprobs?: boolean;
  topLogprobs?: number;
  streamOptions?: StreamOptions;
  parallelToolCalls?: boolean;
  /**
   * Allow-listed wire fields the gateway does not model (reasoning_effort,
   * store, metadata, provider knobs such as top_k …), keyed by their OpenAI
   * wire (snake_case) name and forwarded upstream verbatim. Typed fields win.
   * See providers/wire-extras.ts.
   */
  extra?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content?: string | readonly ContentPart[];
  name?: string;
  toolCalls?: readonly ToolCall[];
  toolCallId?: string;
  /** Allow-listed wire fields on a message (reasoning_content, refusal, annotations …), snake_case. */
  extra?: Record<string, unknown>;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  imageUrl?: { url: string; detail?: "auto" | "low" | "high" };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    /** Structured-outputs strict mode for this function's arguments. */
    strict?: boolean;
  };
}

export type ToolChoice = "none" | "auto" | "required" | { type: "function"; function: { name: string } };

export interface ResponseFormat {
  type: "json_object" | "text" | "json_schema";
  /** Structured-outputs schema, required when type is "json_schema". */
  jsonSchema?: Record<string, unknown>;
}

export interface StreamOptions {
  includeUsage: boolean;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Position of this call in a streaming delta; OpenAI addresses partial tool calls by it. */
  index?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  provider: string;
  choices: readonly Choice[];
  usage: Usage;
  overheadMs?: number;
  metadata?: Record<string, unknown>;
  /** Forwardable upstream HTTP response headers (whitelist-filtered). */
  upstreamHeaders?: Readonly<Record<string, string>>;
  /** Allow-listed top-level wire fields (system_fingerprint, service_tier, citations …), snake_case. */
  extra?: Record<string, unknown>;
}

export interface Choice {
  index: number;
  message?: ChatMessage;
  delta?: ChatMessage;
  finishReason: string;
  /** Upstream `logprobs` object, forwarded as-is (null/absent when not requested). */
  logprobs?: unknown;
  /** Allow-listed choice-level wire fields (content_filter_results …), snake_case. */
  extra?: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptTokensDetails?: Record<string, number>;
  completionTokensDetails?: Record<string, number>;
  /** Allow-listed usage wire fields (cost, prompt_cache_hit_tokens …), snake_case. */
  extra?: Record<string, unknown>;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: readonly Choice[];
  usage?: Usage;
  /** Allow-listed top-level wire fields (system_fingerprint, citations …), snake_case. */
  extra?: Record<string, unknown>;
}

// --- Embeddings ---

export interface EmbeddingRequest {
  model: string;
  input: string | readonly string[];
  dimensions?: number;
  /** OpenAI `encoding_format`: "base64" returns each embedding as a base64 string. */
  encodingFormat?: "float" | "base64";
  user?: string;
}

export interface EmbeddingResponse {
  object: string;
  model: string;
  provider: string;
  /** `embedding` is a base64 string when the request asked for encoding_format "base64". */
  data: readonly { object: string; embedding: readonly number[] | string; index: number }[];
  usage: Usage;
}

// --- Images ---

export interface ImageRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  responseFormat?: "url" | "b64_json";
  /** OpenAI `quality` (e.g. "standard" | "hd" for dall-e-3; "low" | "medium" | "high" | "auto" for gpt-image-1). */
  quality?: string;
  /** OpenAI `style` ("vivid" | "natural", dall-e-3). */
  style?: string;
  user?: string;
}

export interface ImageResponse {
  created: number;
  provider: string;
  data: readonly { url?: string; b64Json?: string; revisedPrompt?: string }[];
}
