/**
 * Qwen (Alibaba DashScope) provider definition.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createQwen(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "qwen",
    baseURL: baseURL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey,
    models: [
      "qwen-max",
      "qwen-plus",
      "qwen-turbo",
      "qwen-long",
      "qwen-vl-max",
      "qwen-vl-plus",
    ],
  });
}
