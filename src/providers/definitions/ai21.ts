/**
 * AI21 Labs provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createAI21(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "ai21",
    baseURL: baseURL ?? "https://api.ai21.com/studio/v1",
    apiKey,
    models: [
      "jamba-1.5-large",
      "jamba-1.5-mini",
    ],
  });
}
