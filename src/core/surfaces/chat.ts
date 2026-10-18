/** Chat completions surface (non-streaming via execute; streaming via callStream). */

import type { PluginContext } from "../../plugins/types.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  IProvider,
  IStreamProvider,
  StreamChunk,
} from "../../providers/types.js";
import type { Surface } from "../types.js";

/**
 * A plugin's short-circuit response, completed to a well-formed chat
 * completion (a plugin may omit usage / id / created; the wire serializer
 * needs them — a missing usage used to answer 500).
 */
export function normalizeShortCircuitResponse(res: ChatCompletionResponse, model: string): ChatCompletionResponse {
  return {
    ...res,
    id: res.id ?? "",
    object: res.object ?? "chat.completion",
    created: typeof res.created === "number" ? res.created : Math.floor(Date.now() / 1000),
    model: res.model ?? model,
    provider: res.provider ?? "none",
    choices: Array.isArray(res.choices) ? res.choices : [],
    usage: res.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

export const chatSurface: Surface<ChatCompletionRequest, ChatCompletionResponse, StreamChunk> = {
  name: "chat",
  capability: "chat",
  logLabel: "chat",
  candidates: "strategy",
  model: (req) => req.model,
  withModel: (req, model) => (model === req.model ? req : { ...req, model }),
  toPluginView: (req) => req,
  applyPluginView: (_req, view) => view,
  supports: () => true,
  call: (p, ctx, req) => p.complete(ctx, req),
  callStream: (p, ctx, req) => (p as IProvider & IStreamProvider).completeStream(ctx, req),
  usage: (res) => res.usage,
  toPluginResponse: (res) => res,
  fromPluginResponse: (_res, view) => view,
  fromShortCircuit: (pc: PluginContext) =>
    pc.response ? normalizeShortCircuitResponse(pc.response, pc.request.model) : undefined,
};
