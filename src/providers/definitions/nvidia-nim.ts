/**
 * NVIDIA NIM provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createNvidiaNim(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "nvidia-nim",
    baseURL: baseURL ?? "https://integrate.api.nvidia.com/v1",
    apiKey,
    models: [
      "meta/llama-3.3-70b-instruct",
      "meta/llama-3.1-8b-instruct",
      "nvidia/nemotron-4-340b-instruct",
      "mistralai/mixtral-8x7b-instruct-v0.1",
    ],
  });
}
