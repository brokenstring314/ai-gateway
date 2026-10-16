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

/** Optional model discovery interface. */
export interface IDiscoveryProvider extends IProvider {
  discoverModels(ctx: RequestContext): Promise<readonly ModelInfo[]>;
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
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content?: string | readonly ContentPart[];
  name?: string;
  toolCalls?: readonly ToolCall[];
  toolCallId?: string;
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
}

export interface Choice {
  index: number;
  message?: ChatMessage;
  delta?: ChatMessage;
  finishReason: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptTokensDetails?: Record<string, number>;
  completionTokensDetails?: Record<string, number>;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: readonly Choice[];
  usage?: Usage;
}

// --- Embeddings ---

export interface EmbeddingRequest {
  model: string;
  input: string | readonly string[];
  dimensions?: number;
  user?: string;
}

export interface EmbeddingResponse {
  object: string;
  model: string;
  provider: string;
  data: readonly { object: string; embedding: readonly number[]; index: number }[];
  usage: Usage;
}

// --- Images ---

export interface ImageRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  responseFormat?: "url" | "b64_json";
  user?: string;
}

export interface ImageResponse {
  created: number;
  provider: string;
  data: readonly { url?: string; b64Json?: string; revisedPrompt?: string }[];
}
