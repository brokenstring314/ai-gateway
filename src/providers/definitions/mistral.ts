/**
 * Mistral provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createMistral(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "mistral",
    baseURL: baseURL ?? "https://api.mistral.ai/v1",
    apiKey,
    models: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "mistral-small-latest",
      "mistral-tiny",
      "codestral-latest",
      "ministral-8b-latest",
      "pixtral-large-latest",
    ],
  });
}
