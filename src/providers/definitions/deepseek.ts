/**
 * DeepSeek provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createDeepSeek(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "deepseek",
    baseURL: baseURL ?? "https://api.deepseek.com/v1",
    apiKey,
    models: [
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  });
}
