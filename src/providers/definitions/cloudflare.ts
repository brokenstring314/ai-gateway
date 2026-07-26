/**
 * Cloudflare Workers AI provider definition.
 *
 * Base URL includes an account_id placeholder that must be configured.
 */
import type { IProvider, IStreamProvider } from "../types.js";
import { createOpenAICompatProvider } from "../openai-compat.js";

export function createCloudflare(apiKey: string, baseURL?: string): IProvider & IStreamProvider {
  return createOpenAICompatProvider({
    name: "cloudflare",
    baseURL: baseURL ?? "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    apiKey,
    models: [
      "@cf/meta/llama-3.3-70b-instruct",
      "@cf/meta/llama-3.1-8b-instruct",
      "@cf/mistral/mistral-7b-instruct-v0.2",
    ],
  });
}
