/**
 * DeepInfra provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createDeepInfra(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "deepinfra",
    baseURL: baseURL ?? "https://api.deepinfra.com/v1/openai",
    apiKey,
    models: [
      "meta-llama/Llama-3.3-70B-Instruct",
      "meta-llama/Meta-Llama-3.1-8B-Instruct",
      "mistralai/Mixtral-8x7B-Instruct-v0.1",
      "deepseek-ai/DeepSeek-R1",
      "deepseek-ai/DeepSeek-V3",
    ],
  });
}
