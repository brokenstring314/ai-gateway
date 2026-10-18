/** Image generation surface: the prompt is shown to plugins as one user message. */

import type { PluginContext } from "../../plugins/types.js";
import type { IImageProvider, ImageRequest, ImageResponse } from "../../providers/types.js";
import { messageText } from "../usage.js";
import type { Surface } from "../types.js";

function isImageResponse(v: unknown): v is ImageResponse {
  return v !== null && typeof v === "object" && Array.isArray((v as { data?: unknown }).data);
}

export const imagesSurface: Surface<ImageRequest, ImageResponse> = {
  name: "images",
  capability: "images",
  logLabel: "image",
  pluginSurfaceTag: "image",
  candidates: "capable",
  unsupportedLabel: "image generation",
  model: (req) => req.model,
  withModel: (req, model) => (model === req.model ? req : { ...req, model }),
  toPluginView: (req) => ({ model: req.model, messages: [{ role: "user", content: req.prompt }] }),
  applyPluginView: (req, view) => ({
    ...req,
    model: view.model,
    prompt: view.messages.map((m) => messageText(m.content)).join("\n"),
  }),
  supports: (p) => "generateImage" in p,
  call: (p, ctx, req) => (p as unknown as IImageProvider).generateImage(ctx, req),
  usage: () => undefined,
  exposeResult: (pc, res) => {
    pc.metadata["_imageResponse"] = res;
  },
  // Images carry no token usage: after-request plugins see no response.
  toPluginResponse: () => undefined,
  fromShortCircuit: (pc: PluginContext) => {
    const supplied = pc.metadata["_imageResponse"];
    return isImageResponse(supplied) ? supplied : undefined;
  },
  shortCircuitUnsupported: "Plugin short-circuited an image request without supplying an image response",
};
