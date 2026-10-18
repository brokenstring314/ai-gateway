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

// Provider factories
export { createOpenAI } from "./definitions/openai.js";
export { createDeepSeek } from "./definitions/deepseek.js";
export { createGroq } from "./definitions/groq.js";
export { createMistral } from "./definitions/mistral.js";
export { createXAI } from "./definitions/xai.js";
export { createQwen } from "./definitions/qwen.js";
export { createMoonshot } from "./definitions/moonshot.js";
export { createTogether } from "./definitions/together.js";
export { createFireworks } from "./definitions/fireworks.js";
export { createDeepInfra } from "./definitions/deepinfra.js";
export { createAI21 } from "./definitions/ai21.js";
export { createCerebras } from "./definitions/cerebras.js";
export { createSambanova } from "./definitions/sambanova.js";
export { createNovita } from "./definitions/novita.js";
export { createNvidiaNim } from "./definitions/nvidia-nim.js";
export { createOllama } from "./definitions/ollama.js";
export { createOpenRouter } from "./definitions/openrouter.js";
export { createPerplexity } from "./definitions/perplexity.js";
export { createReplicate } from "./definitions/replicate.js";
export { createCloudflare } from "./definitions/cloudflare.js";
export { createDatabricks } from "./definitions/databricks.js";
export { createHuggingFace } from "./definitions/huggingface.js";
