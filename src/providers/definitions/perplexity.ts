/**
 * Perplexity provider definition.
 *
 * Perplexity returns a `citations` field in its responses.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createPerplexity(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "perplexity",
    baseURL: baseURL ?? "https://api.perplexity.ai",
    apiKey,
    extraResponseFields: ["citations"],
    models: [
      "sonar-pro",
      "sonar",
      "sonar-reasoning",
      "sonar-deep-research",
    ],
  });
}
