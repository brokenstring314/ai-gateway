/** Embeddings surface: input items are shown to plugins as one user message each. */

import type { PluginContext } from "../../plugins/types.js";
import type { EmbeddingRequest, EmbeddingResponse, IEmbeddingProvider } from "../../providers/types.js";
import { messageText } from "../usage.js";
import type { Surface } from "../types.js";

function isEmbeddingResponse(v: unknown): v is EmbeddingResponse {
  return v !== null && typeof v === "object" && Array.isArray((v as { data?: unknown }).data);
}

export const embeddingsSurface: Surface<EmbeddingRequest, EmbeddingResponse> = {
  name: "embeddings",
  capability: "embeddings",
  logLabel: "embedding",
  pluginSurfaceTag: "embedding",
  candidates: "capable",
  unsupportedLabel: "embeddings",
  model: (req) => req.model,
  withModel: (req, model) => (model === req.model ? req : { ...req, model }),
  toPluginView: (req) => {
    const items: readonly string[] = typeof req.input === "string" ? [req.input] : req.input;
    return { model: req.model, messages: items.map((text) => ({ role: "user" as const, content: text })) };
  },
  applyPluginView: (req, view) => {
    const texts = view.messages.map((m) => messageText(m.content));
    return {
      ...req,
      model: view.model,
      input: typeof req.input === "string" && texts.length === 1 ? texts[0]! : texts,
    };
  },
  supports: (p) => "embed" in p,
  call: (p, ctx, req) => (p as unknown as IEmbeddingProvider).embed(ctx, req),
  usage: (res) => res.usage,
  exposeResult: (pc, res) => {
    pc.metadata["_embeddingResponse"] = res;
  },
  // Usage for after-request plugins (budget) as a chat-shaped response.
  toPluginResponse: (res) => {
    const promptTokens = res.usage?.promptTokens ?? 0;
    return {
      id: "",
      object: "embedding",
      created: Math.floor(Date.now() / 1000),
      model: res.model,
      provider: res.provider,
      choices: [],
      usage: { promptTokens, completionTokens: 0, totalTokens: res.usage?.totalTokens ?? promptTokens },
    };
  },
  fromShortCircuit: (pc: PluginContext) => {
    const supplied = pc.metadata["_embeddingResponse"];
    return isEmbeddingResponse(supplied) ? supplied : undefined;
  },
  shortCircuitUnsupported: "Plugin short-circuited an embedding request without supplying an embedding response",
};
