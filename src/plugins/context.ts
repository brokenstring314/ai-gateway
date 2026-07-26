import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";
import type { PluginContext } from "./types.js";

export interface InternalPluginContext extends PluginContext {
  _shortCircuited: boolean;
}

export function createPluginContext(request: ChatCompletionRequest): InternalPluginContext {
  const ctx: InternalPluginContext = {
    request,
    response: undefined,
    error: undefined,
    metadata: {},
    _shortCircuited: false,
    shortCircuit(response: ChatCompletionResponse): void {
      ctx._shortCircuited = true;
      ctx.response = response;
    },
  };
  return ctx;
}
