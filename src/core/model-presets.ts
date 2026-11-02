/**
 * What is known about upstream models, by provider preset (0.3.0 P3).
 *
 * Used two ways:
 *  - config validation: a published model must not promise more than the
 *    upstream it is bound to (a larger context window or output limit, an
 *    input type or feature the upstream lacks is a config error);
 *  - defaults: a published model's unset metadata falls back to what every
 *    bound upstream supports (the smallest limit, the common features).
 *
 * Only models with a documented source are listed; anything else is
 * unknown and stays unchecked. Keep the source and its date next to each
 * entry (an upstream's own /models listing is the best source).
 */

import type { ModelMetadata } from "../config/types.js";
import { presetId } from "./provider-presets.js";

type Known = Readonly<Required<Pick<ModelMetadata, "contextWindow" | "maxOutputTokens" | "inputModalities">>> &
  Readonly<Pick<ModelMetadata, "tools" | "structuredOutput" | "reasoning">>;

// DeepSeek: GET https://api.deepseek.com/models (context_window,
// max_output_tokens, input_modalities) and
// https://api-docs.deepseek.com/quick_start/pricing (JSON output, tool calls,
// thinking mode), both checked 2026-11-01.
const DEEPSEEK_FLASH: Known = {
  contextWindow: 1_048_576,
  maxOutputTokens: 393_216,
  inputModalities: ["text", "image"],
  tools: true,
  structuredOutput: "json_object",
  reasoning: true,
};

const KNOWN: Readonly<Record<string, Readonly<Record<string, Known>>>> = {
  deepseek: {
    "deepseek-flash": DEEPSEEK_FLASH,
    // Legacy names, served by the same model (same source).
    "deepseek-v4-flash": DEEPSEEK_FLASH,
    "deepseek-v4-flash-vision-exp": DEEPSEEK_FLASH,
    "deepseek-v4-pro": { ...DEEPSEEK_FLASH, inputModalities: ["text"] },
  },
};

/** Known facts about `model` on a target of `provider`, or undefined. */
export function knownUpstreamModel(provider: string, model: string): Known | undefined {
  return KNOWN[presetId(provider)]?.[model];
}

/** Every documented upstream model of a provider preset (Admin API GET /presets). */
export function knownUpstreamModels(provider: string): Readonly<Record<string, Known>> {
  return KNOWN[presetId(provider)] ?? {};
}
