/**
 * Fireworks AI provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createFireworks(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "fireworks",
    baseURL: baseURL ?? "https://api.fireworks.ai/inference/v1",
    apiKey,
    models: [
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/llama-v3p1-8b-instruct",
      "accounts/fireworks/models/mixtral-8x7b-instruct",
      "accounts/fireworks/models/deepseek-r1",
      "accounts/fireworks/models/deepseek-v3",
    ],
  });
}
