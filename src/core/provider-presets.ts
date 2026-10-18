/**
 * Provider presets: the single table of known OpenAI-compatible providers.
 *
 * Every provider is driven by the same adapter (providers/openai-compat.ts);
 * a preset only supplies the default base URL and any provider-specific
 * request headers or response fields. Capability checks are keyed on the
 * preset id (`target.provider`), never on the target's own name.
 *
 * Replaces the per-provider `providers/definitions/*.ts` factories and the
 * gateway's own PROVIDER_FACTORIES map (two diverging copies before 0.2.0).
 */

import type { CompatibilityConfig, TargetConfig } from "../config/types.js";
import { expandTargetEnvRefs } from "../config/envref.js";
import { createOpenAICompatProvider, type OpenAICompatProvider } from "../providers/openai-compat.js";

export interface ProviderPreset {
  /** Default base URL; absent when it is account/workspace specific. */
  readonly baseURL?: string;
  /** Extra request headers sent on every call. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Non-standard top-level response fields kept in response metadata. */
  readonly extraResponseFields?: readonly string[];
  /** apiKey used when the target's is empty (local servers without auth). */
  readonly defaultApiKey?: string;
  /** Example baseURL shown when one is mandatory. */
  readonly baseURLHint?: string;
}

export const PROVIDER_PRESETS: Readonly<Record<string, ProviderPreset>> = {
  openai: { baseURL: "https://api.openai.com/v1" },
  deepseek: { baseURL: "https://api.deepseek.com/v1" },
  groq: { baseURL: "https://api.groq.com/openai/v1" },
  mistral: { baseURL: "https://api.mistral.ai/v1" },
  xai: { baseURL: "https://api.x.ai/v1" },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  moonshot: { baseURL: "https://api.moonshot.cn/v1" },
  together: { baseURL: "https://api.together.xyz/v1" },
  fireworks: { baseURL: "https://api.fireworks.ai/inference/v1" },
  deepinfra: { baseURL: "https://api.deepinfra.com/v1/openai" },
  ai21: { baseURL: "https://api.ai21.com/studio/v1" },
  cerebras: { baseURL: "https://api.cerebras.ai/v1" },
  sambanova: { baseURL: "https://api.sambanova.ai/v1" },
  novita: { baseURL: "https://api.novita.ai/v3/openai" },
  nvidia_nim: { baseURL: "https://integrate.api.nvidia.com/v1" },
  ollama: { baseURL: "http://localhost:11434/v1", defaultApiKey: "ollama" },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    // OpenRouter attribution / ranking headers.
    extraHeaders: { "HTTP-Referer": "https://github.com/brokenstring314/ai-gateway", "X-Title": "ai-gateway" },
  },
  perplexity: { baseURL: "https://api.perplexity.ai", extraResponseFields: ["citations", "search_results"] },
  replicate: { baseURL: "https://api.replicate.com/v1" },
  huggingface: { baseURL: "https://api-inference.huggingface.co/v1" },
  // Account / workspace specific: the old defaults were not usable URLs.
  cloudflare: { baseURLHint: "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1" },
  databricks: { baseURLHint: "https://<workspace>.cloud.databricks.com/serving-endpoints" },
};

/** Accepted spellings → preset id. */
const PRESET_ALIASES: Readonly<Record<string, string>> = {
  "nvidia-nim": "nvidia_nim",
  nim: "nvidia_nim",
  "x-ai": "xai",
  dashscope: "qwen",
};

/** Preset id for a `target.provider` value (case-insensitive, aliases applied). */
export function presetId(provider: string): string {
  const p = provider.trim().toLowerCase();
  return PRESET_ALIASES[p] ?? p;
}

export function getPreset(provider: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[presetId(provider)];
}

/**
 * Why a target cannot be built (no usable base URL), or undefined when it can.
 * Shared by config validation and provider construction.
 */
export function baseURLProblem(target: Pick<TargetConfig, "name" | "provider" | "baseURL">): string | undefined {
  if (target.baseURL !== undefined && target.baseURL !== "") return undefined;
  const preset = getPreset(target.provider);
  if (preset?.baseURL !== undefined) return undefined;
  if (preset?.baseURLHint !== undefined) {
    return `target "${target.name}": provider "${target.provider}" needs an explicit baseURL (e.g. ${preset.baseURLHint})`;
  }
  return (
    `target "${target.name}": unknown provider "${target.provider}" needs a baseURL ` +
    `(known providers: ${Object.keys(PROVIDER_PRESETS).join(", ")})`
  );
}

/** Base URL for a target after `${VAR}` expansion: explicit, else the preset default. */
export function resolveBaseURL(target: Pick<TargetConfig, "name" | "provider" | "baseURL">): string {
  const problem = baseURLProblem(target);
  if (problem !== undefined) throw new Error(problem);
  const url =
    target.baseURL !== undefined && target.baseURL !== "" ? target.baseURL : (getPreset(target.provider)?.baseURL ?? "");
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(`target "${target.name}": baseURL is not a valid http(s) URL after \${VAR} expansion`);
  }
  return url;
}

/**
 * Build the provider for a target. `${VAR}` refs in apiKey/baseURL are
 * expanded here (the stored config keeps the templates), then the URL is
 * validated.
 */
export function createProviderFromTarget(
  rawTarget: TargetConfig,
  compatibility?: CompatibilityConfig["onUnsupportedParam"],
): OpenAICompatProvider {
  const target = expandTargetEnvRefs(rawTarget);
  const preset = getPreset(target.provider);
  return createOpenAICompatProvider({
    name: target.name,
    providerType: presetId(target.provider),
    baseURL: resolveBaseURL(target),
    apiKey: target.apiKey || preset?.defaultApiKey || "",
    models: target.models,
    extraHeaders: preset?.extraHeaders ? { ...preset.extraHeaders } : undefined,
    extraResponseFields: preset?.extraResponseFields,
    compatibility,
  });
}
