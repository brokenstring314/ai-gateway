/**
 * Novita AI provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createNovita(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "novita",
    baseURL: baseURL ?? "https://api.novita.ai/v3/openai",
    apiKey,
    models: [
      "meta-llama/llama-3.3-70b-instruct",
      "meta-llama/llama-3.1-8b-instruct",
      "deepseek/deepseek-r1",
      "deepseek/deepseek-v3",
      "qwen/qwen-2.5-72b-instruct",
    ],
  });
}
