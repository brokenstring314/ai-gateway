/**
 * Replicate provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createReplicate(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "replicate",
    baseURL: baseURL ?? "https://api.replicate.com/v1",
    apiKey,
    models: [
      "meta/meta-llama-3.1-405b-instruct",
      "meta/meta-llama-3.1-70b-instruct",
    ],
  });
}
