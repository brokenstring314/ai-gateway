/**
 * OpenAI provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createOpenAI(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "openai",
    baseURL: baseURL ?? "https://api.openai.com/v1",
    apiKey,
    models: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4o-2024-11-20",
      "gpt-4-turbo",
      "gpt-4-turbo-2024-04-09",
      "gpt-4",
      "gpt-4-0613",
      "gpt-3.5-turbo",
      "gpt-3.5-turbo-0125",
      "o1",
      "o1-mini",
      "o1-preview",
      "o3-mini",
    ],
  });
}
