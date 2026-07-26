/**
 * Sambanova provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createSambanova(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "sambanova",
    baseURL: baseURL ?? "https://api.sambanova.ai/v1",
    apiKey,
    models: [
      "Meta-Llama-3.3-70B-Instruct",
      "Meta-Llama-3.1-8B-Instruct",
      "DeepSeek-R1",
    ],
  });
}
