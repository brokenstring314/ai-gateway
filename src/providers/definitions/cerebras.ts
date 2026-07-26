/**
 * Cerebras provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createCerebras(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "cerebras",
    baseURL: baseURL ?? "https://api.cerebras.ai/v1",
    apiKey,
    models: [
      "llama3.1-8b",
      "llama3.1-70b",
    ],
  });
}
