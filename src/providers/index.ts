/**
 * Provider system barrel export.
 *
 * Re-exports all public types, the registry, the universal adapter,
 * capabilities, and all provider factory functions.
 */

// Types
export type {
  IProvider,
  IStreamProvider,
  IEmbeddingProvider,
  IImageProvider,
  IProviderSource,
  RequestContext,
  ModelInfo,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentPart,
  ToolDefinition,
  ToolChoice,
  ResponseFormat,
  ToolCall,
  Choice,
  Usage,
  StreamChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageRequest,
  ImageResponse,
} from "./types.js";

// Registry
export { ProviderRegistry } from "./registry.js";

// Universal adapter
export { createOpenAICompatProvider, ProviderError } from "./openai-compat.js";
export type { OpenAiCompatOptions } from "./openai-compat.js";

// SSE parser
export { parseSSEStream, ReadableStreamError } from "./sse-parser.js";

// Capabilities
export {
  ProviderCapability,
  getCapabilities,
  enforceUnsupportedParams,
  supportsCapability,
} from "./capabilities.js";
export type { CapabilityEnforcementResult } from "./capabilities.js";

// Provider presets (one table; replaces the per-provider definitions)
export {
  PROVIDER_PRESETS,
  createProviderFromTarget,
  getPreset,
  presetId,
} from "../core/provider-presets.js";
export type { ProviderPreset } from "../core/provider-presets.js";
