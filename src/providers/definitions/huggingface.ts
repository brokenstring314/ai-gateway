/**
 * Hugging Face Inference provider definition.
 *
 * Uses Hugging Face's serverless inference API with OpenAI-compatible endpoint.
 * API key is a Hugging Face access token (hf_...).
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createHuggingFace(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "huggingface",
    baseURL: baseURL ?? "https://api-inference.huggingface.co/v1",
    apiKey,
    models: [
      "meta-llama/Llama-3.3-70B-Instruct",
      "meta-llama/Llama-3.1-8B-Instruct",
      "mistralai/Mixtral-8x7B-Instruct-v0.1",
      "Qwen/Qwen2.5-72B-Instruct",
    ],
  });
}
