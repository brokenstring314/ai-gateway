/**
 * Ollama (local) provider definition.
 *
 * Ollama runs on localhost with no authentication.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createOllama(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "ollama",
    baseURL: baseURL ?? "http://localhost:11434/v1",
    apiKey, // Ollama doesn't require auth, but we accept the param for API uniformity
    models: [
      "llama3.2",
      "llama3.1:8b",
      "mistral",
      "mixtral:8x7b",
      "gemma2",
      "qwen2.5",
      "deepseek-r1",
    ],
  });
}
