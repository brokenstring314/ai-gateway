/**
 * Provider capability matrix — declares which OpenAI chat completion parameters
 * each provider supports, plus enforcement logic for unsupported parameters.
 */

import type { ChatCompletionRequest } from "./types.js";
import type { CompatibilityConfig } from "../config/types.js";

/** Every parameter that a provider may or may not support. */
export const ProviderCapability = {
  Temperature: "temperature",
  TopP: "top_p",
  N: "n",
  Stream: "stream",
  Stop: "stop",
  MaxTokens: "max_tokens",
  MaxCompletionTokens: "max_completion_tokens",
  PresencePenalty: "presence_penalty",
  FrequencyPenalty: "frequency_penalty",
  LogitBias: "logit_bias",
  User: "user",
  Seed: "seed",
  Tools: "tools",
  ToolChoice: "tool_choice",
  ResponseFormat: "response_format",
  Logprobs: "logprobs",
  TopLogprobs: "top_logprobs",
  StreamOptions: "stream_options",
  /** Vision / image_url content parts. */
  Vision: "vision",
  /** Developer role (o1-style system messages). */
  DeveloperRole: "developer_role",
} as const;

export type ProviderCapability = (typeof ProviderCapability)[keyof typeof ProviderCapability];

/**
 * The full set of capabilities — default capability set for a fully-featured
 * OpenAI-compatible provider.
 */
const ALL_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set(Object.values(ProviderCapability));

/**
 * Per-provider capability overrides.
 *
 * Providers NOT listed here default to ALL capabilities.
 * Providers listed here have only their listed capabilities.
 */
const PROVIDER_CAPABILITY_MAP: Readonly<Record<string, ReadonlySet<ProviderCapability>>> = {
  // DeepSeek: no logprobs support.
  deepseek: without(ALL_CAPABILITIES, ProviderCapability.Logprobs, ProviderCapability.TopLogprobs),

  // Groq: no logprobs, no seed.
  groq: without(ALL_CAPABILITIES, ProviderCapability.Logprobs, ProviderCapability.TopLogprobs, ProviderCapability.Seed),

  // Mistral: no logprobs, no seed, no stream_options.
  mistral: without(
    ALL_CAPABILITIES,
    ProviderCapability.Logprobs,
    ProviderCapability.TopLogprobs,
    ProviderCapability.Seed,
    ProviderCapability.StreamOptions,
  ),

  // Ollama: subset for local models.
  ollama: new Set([
    ProviderCapability.Temperature,
    ProviderCapability.TopP,
    ProviderCapability.Stop,
    ProviderCapability.MaxTokens,
    ProviderCapability.Stream,
    ProviderCapability.Seed,
  ]),

  // Replicate: limited subset.
  replicate: new Set([
    ProviderCapability.Temperature,
    ProviderCapability.TopP,
    ProviderCapability.MaxTokens,
    ProviderCapability.Stop,
    ProviderCapability.Stream,
  ]),

  // Cerebras: no logprobs, no seed.
  cerebras: without(
    ALL_CAPABILITIES,
    ProviderCapability.Logprobs,
    ProviderCapability.TopLogprobs,
    ProviderCapability.Seed,
  ),

  // AI21: no logprobs, no stream_options.
  ai21: without(
    ALL_CAPABILITIES,
    ProviderCapability.Logprobs,
    ProviderCapability.TopLogprobs,
    ProviderCapability.StreamOptions,
  ),

  // Novita: no seed, no logprobs.
  novita: without(
    ALL_CAPABILITIES,
    ProviderCapability.Logprobs,
    ProviderCapability.TopLogprobs,
    ProviderCapability.Seed,
  ),

  // Cloudflare: basic subset.
  cloudflare: new Set([
    ProviderCapability.Temperature,
    ProviderCapability.TopP,
    ProviderCapability.MaxTokens,
    ProviderCapability.Stop,
    ProviderCapability.Stream,
  ]),

  // HuggingFace TGI: subset.
  huggingface: new Set([
    ProviderCapability.Temperature,
    ProviderCapability.TopP,
    ProviderCapability.MaxTokens,
    ProviderCapability.Stop,
    ProviderCapability.Stream,
    ProviderCapability.Seed,
  ]),

  // Sambanova: no logprobs.
  sambanova: without(ALL_CAPABILITIES, ProviderCapability.Logprobs, ProviderCapability.TopLogprobs),
};

/** Create a set excluding specific items. */
function without(
  base: ReadonlySet<ProviderCapability>,
  ...remove: ProviderCapability[]
): ReadonlySet<ProviderCapability> {
  const result = new Set(base);
  for (const item of remove) result.delete(item);
  return result;
}

/**
 * Get the set of capabilities for a given provider name.
 * Providers not explicitly listed default to ALL capabilities.
 */
export function getCapabilities(providerName: string): ReadonlySet<ProviderCapability> {
  return PROVIDER_CAPABILITY_MAP[providerName] ?? ALL_CAPABILITIES;
}

/**
 * Capability request → capability mapping.
 *
 * Maps fields on ChatCompletionRequest to their corresponding capability.
 */
const FIELD_TO_CAPABILITY: Readonly<Record<string, ProviderCapability>> = {
  temperature: ProviderCapability.Temperature,
  topP: ProviderCapability.TopP,
  n: ProviderCapability.N,
  stream: ProviderCapability.Stream,
  stop: ProviderCapability.Stop,
  maxTokens: ProviderCapability.MaxTokens,
  maxCompletionTokens: ProviderCapability.MaxCompletionTokens,
  presencePenalty: ProviderCapability.PresencePenalty,
  frequencyPenalty: ProviderCapability.FrequencyPenalty,
  logitBias: ProviderCapability.LogitBias,
  user: ProviderCapability.User,
  seed: ProviderCapability.Seed,
  tools: ProviderCapability.Tools,
  toolChoice: ProviderCapability.ToolChoice,
  responseFormat: ProviderCapability.ResponseFormat,
  logprobs: ProviderCapability.Logprobs,
  topLogprobs: ProviderCapability.TopLogprobs,
  streamOptions: ProviderCapability.StreamOptions,
};

/**
 * Result of enforcing unsupported parameters.
 *
 * - "ok": all params supported, request passes through.
 * - "dropped": some params were silently removed, cleaned request returned.
 * - "rejected": request rejected, error message returned.
 */
export type CapabilityEnforcementResult =
  | { action: "ok"; request: ChatCompletionRequest }
  | { action: "dropped"; request: ChatCompletionRequest; dropped: string[] }
  | { action: "rejected"; reason: string };

/**
 * Enforce provider capabilities against a request.
 *
 * Depending on `mode`:
 * - "warn": log a warning for unsupported params, pass through as-is.
 * - "drop": silently remove unsupported params from the request.
 * - "reject": return an error if any unsupported param is present.
 */
export function enforceUnsupportedParams(
  providerName: string,
  request: ChatCompletionRequest,
  mode: CompatibilityConfig["onUnsupportedParam"],
  /** Name used in messages (the target); defaults to providerName. */
  displayName: string = providerName,
): CapabilityEnforcementResult {
  const capabilities = getCapabilities(providerName);
  // Unsupported request fields, by their ChatCompletionRequest (camelCase) key.
  const unsupportedFields: Array<keyof ChatCompletionRequest> = [];
  // Unsupported features inside messages (cannot be dropped field-wise).
  const unsupportedFeatures: string[] = [];

  for (const [field, capability] of Object.entries(FIELD_TO_CAPABILITY)) {
    const key = field as keyof ChatCompletionRequest;
    const value = request[key];
    if (value === undefined || value === null) continue;
    // An empty tools array is treated as absent.
    if (key === "tools" && Array.isArray(value) && value.length === 0) continue;
    if (!capabilities.has(capability)) unsupportedFields.push(key);
  }

  const hasDeveloper = request.messages?.some((m) => m.role === "developer") ?? false;
  if (hasDeveloper && !capabilities.has(ProviderCapability.DeveloperRole)) {
    unsupportedFeatures.push("developer_role");
  }
  const hasVision =
    request.messages?.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) ?? false;
  if (hasVision && !capabilities.has(ProviderCapability.Vision)) {
    unsupportedFeatures.push("vision");
  }

  // Wire (snake_case) parameter names, as the client sent them.
  const labels = [
    ...unsupportedFields.map((f) => FIELD_TO_CAPABILITY[f as string] ?? String(f)),
    ...unsupportedFeatures,
  ];
  if (labels.length === 0) {
    return { action: "ok", request };
  }

  switch (mode) {
    case "warn": {
      console.warn(`[${displayName}] unsupported params (passing through): ${labels.join(", ")}`);
      return { action: "ok", request };
    }
    case "drop": {
      const cleaned: ChatCompletionRequest = { ...request };
      for (const field of unsupportedFields) delete cleaned[field];
      if (unsupportedFeatures.includes("developer_role")) {
        // Closest equivalent for providers without the developer role.
        cleaned.messages = cleaned.messages.map((m) => (m.role === "developer" ? { ...m, role: "system" } : m));
      }
      if (unsupportedFeatures.includes("vision")) {
        // Image parts can't be dropped without changing the prompt's meaning.
        console.warn(`[${displayName}] vision content is not supported (passing through)`);
      }
      return { action: "dropped", request: cleaned, dropped: labels };
    }
    case "reject": {
      return { action: "rejected", reason: `${displayName} does not support: ${labels.join(", ")}` };
    }
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return { action: "ok", request };
    }
  }
}

/** Check if a provider supports a specific capability. */
export function supportsCapability(providerName: string, capability: ProviderCapability): boolean {
  return getCapabilities(providerName).has(capability);
}
