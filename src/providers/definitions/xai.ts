/**
 * xAI (Grok) provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createXAI(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "xai",
    baseURL: baseURL ?? "https://api.x.ai/v1",
    apiKey,
    models: [
      "grok-2",
      "grok-2-vision",
      "grok-beta",
    ],
  });
}
