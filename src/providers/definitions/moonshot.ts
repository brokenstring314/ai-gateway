/**
 * Moonshot (Kimi) provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createMoonshot(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "moonshot",
    baseURL: baseURL ?? "https://api.moonshot.cn/v1",
    apiKey,
    models: [
      "moonshot-v1-8k",
      "moonshot-v1-32k",
      "moonshot-v1-128k",
    ],
  });
}
