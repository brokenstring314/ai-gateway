import { hashKey } from "../auth/key-hash.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  RequestContext,
} from "../providers/types.js";
import type { PluginContext } from "./types.js";

export interface InternalPluginContext extends PluginContext {
  _shortCircuited: boolean;
  /** Name of the before-request plugin that short-circuited, if any. */
  _shortCircuitedBy?: string;
  /** Names of the before-request plugins that returned a modified request. */
  _modifiedBy?: string[];
}

/**
 * Stable, non-reversible identifier for an API key. Plugins bucket by this
 * (rate-limit, budget, cache tenant) so the raw secret never lands in plugin
 * metadata or logs.
 */
export function apiKeyId(apiKey: string): string {
  return "key_" + hashKey(apiKey).slice(0, 32);
}

export function createPluginContext(
  request: ChatCompletionRequest,
  reqCtx?: RequestContext,
): InternalPluginContext {
  const metadata: Record<string, unknown> = {};
  // Callers may pass a bare context without metadata; tolerate it.
  const apiKey = (reqCtx?.metadata as Record<string, unknown> | undefined)?.["apiKey"];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    metadata["api_key"] = apiKeyId(apiKey);
  }

  const ctx: InternalPluginContext = {
    request,
    response: undefined,
    error: undefined,
    metadata,
    _shortCircuited: false,
    shortCircuit(response: ChatCompletionResponse): void {
      ctx._shortCircuited = true;
      ctx.response = response;
    },
  };
  return ctx;
}
