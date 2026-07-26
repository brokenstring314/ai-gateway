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

/** Human-readable name for each capability (used in warnings/errors). */
const CAPABILITY_LABELS: Record<ProviderCapability, string> = {
  temperature: "temperature",
  top_p: "topP",
  n: "n",
  stream: "stream",
  stop: "stop",
  max_tokens: "maxTokens",
  max_completion_tokens: "maxCompletionTokens",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  logit_bias: "logitBias",
  user: "user",
  seed: "seed",
  tools: "tools",
  tool_choice: "toolChoice",
  response_format: "responseFormat",
  logprobs: "logprobs",
  top_logprobs: "topLogprobs",
  stream_options: "streamOptions",
  vision: "vision",
  developer_role: "developerRole",
};

/** Reverse label → capability mapping for param names. */
const LABEL_TO_CAPABILITY: Record<string, ProviderCapability> = {};
for (const [cap, label] of Object.entries(CAPABILITY_LABELS)) {
  LABEL_TO_CAPABILITY[label] = cap as ProviderCapability;
}

/**
 * The full set of capabilities — default capability set for a fully-featured
 * OpenAI-compatible provider.
 */
const ALL_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set(
  Object.values(ProviderCapability),
);

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
  mistral: without(ALL_CAPABILITIES, ProviderCapability.Logprobs, ProviderCapability.TopLogprobs, ProviderCapability.Seed, ProviderCapability.StreamOptions),

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
  cerebras: without(ALL_CAPABILITIES, ProviderCapability.Logprobs, ProviderCapability.TopLogprobs, ProviderCapability.Seed),

  // AI21: no logprobs, no stream_options.
  ai21: without(ALL_CAPABILITIES, ProviderCapability.Logprobs, ProviderCapability.TopLogprobs, ProviderCapability.StreamOptions),

  // Novita: no seed, no logprobs.
  novita: without(ALL_CAPABILITIES, ProviderCapability.Logprobs, ProviderCapability.TopLogprobs, ProviderCapability.Seed),

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
function without(base: ReadonlySet<ProviderCapability>, ...remove: ProviderCapability[]): ReadonlySet<ProviderCapability> {
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
): CapabilityEnforcementResult {
  const capabilities = getCapabilities(providerName);
  const unsupported: string[] = [];

  for (const [field, capability] of Object.entries(FIELD_TO_CAPABILITY)) {
    const key = field as keyof ChatCompletionRequest;
    const value = request[key];
    if (value === undefined || value === null) continue;

    // Special case: tools is empty array — treat as absent.
    if (key === "tools" && Array.isArray(value) && value.length === 0) continue;

    // Special case: developer role check.
    if (key === "messages") {
      const msgs = request.messages;
      if (msgs) {
        const hasDeveloper = msgs.some((m) => m.role === "developer");
        if (hasDeveloper && !capabilities.has(ProviderCapability.DeveloperRole)) {
          unsupported.push("developer_role (message role)");
        }
      }
      continue;
    }

    if (!capabilities.has(capability)) {
      unsupported.push(LABEL_TO_CAPABILITY[field] ?? field);
    }
  }

  // Check for vision content in messages.
  if (!capabilities.has(ProviderCapability.Vision)) {
    const hasVision = request.messages?.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
    );
    if (hasVision) {
      unsupported.push("vision");
    }
  }

  if (unsupported.length === 0) {
    return { action: "ok", request };
  }

  switch (mode) {
    case "warn": {
      console.warn(
        `[${providerName}] unsupported params (passing through): ${unsupported.join(", ")}`,
      );
      return { action: "ok", request };
    }
    case "drop": {
      const cleaned = dropUnsupportedFields(request, unsupported);
      return { action: "dropped", request: cleaned, dropped: unsupported };
    }
    case "reject": {
      return {
        action: "rejected",
        reason: `${providerName} does not support: ${unsupported.join(", ")}`,
      };
    }
    default: {
      // Exhaustive check.
      const _exhaustive: never = mode;
      void _exhaustive;
      return { action: "ok", request };
    }
  }
}

/**
 * Return a copy of the request with unsupported fields removed/set to undefined.
 */
function dropUnsupportedFields(
  request: ChatCompletionRequest,
  unsupported: string[],
): ChatCompletionRequest {
  const copy = { ...request };

  for (const cap of unsupported) {
    switch (cap) {
      case "temperature":
        delete copy.temperature;
        break;
      case "topP":
        delete copy.topP;
        break;
      case "n":
        delete copy.n;
        break;
      case "stream":
        delete copy.stream;
        break;
      case "stop":
        delete copy.stop;
        break;
      case "maxTokens":
        delete copy.maxTokens;
        break;
      case "maxCompletionTokens":
        delete copy.maxCompletionTokens;
        break;
      case "presencePenalty":
        delete copy.presencePenalty;
        break;
      case "frequencyPenalty":
        delete copy.frequencyPenalty;
        break;
      case "logitBias":
        delete copy.logitBias;
        break;
      case "user":
        delete copy.user;
        break;
      case "seed":
        delete copy.seed;
        break;
      case "tools":
        delete copy.tools;
        break;
      case "toolChoice":
        delete copy.toolChoice;
        break;
      case "responseFormat":
        delete copy.responseFormat;
        break;
      case "logprobs":
        delete copy.logprobs;
        break;
      case "topLogprobs":
        delete copy.topLogprobs;
        break;
      case "streamOptions":
        delete copy.streamOptions;
        break;
      // vision and developer_role are not top-level fields; handled earlier.
    }
  }

  return copy;
}

/** Check if a provider supports a specific capability. */
export function supportsCapability(providerName: string, capability: ProviderCapability): boolean {
  return getCapabilities(providerName).has(capability);
}
