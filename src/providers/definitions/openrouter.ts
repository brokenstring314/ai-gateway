/**
 * OpenRouter provider definition.
 *
 * OpenRouter requires an HTTP-Referer header for ranking.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createOpenRouter(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "openrouter",
    baseURL: baseURL ?? "https://openrouter.ai/api/v1",
    apiKey,
    extraHeaders: {
      "HTTP-Referer": "https://github.com/ai-gateway",
    },
    models: [
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash",
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-r1",
    ],
  });
}
