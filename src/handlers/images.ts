/**
 * Image generations handler — POST /v1/images/generations
 */

import { z } from "zod";
import type { AppType } from "../app.js";
import { respondError, respondInvalidJson, respondValidation } from "./error-response.js";
import type { Gateway } from "../gateway.js";
import { toOpenAIWireImageResponse, fromOpenAIWireImageRequest } from "./openai-wire.js";
import { linkAbortSignals } from "./abort.js";

const ImageRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  n: z.number().int().positive().max(10).optional(),
  size: z.string().optional(),
  responseFormat: z.enum(["url", "b64_json"]).optional(),
  quality: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  user: z.string().optional(),
});


export function registerImagesHandler(app: AppType, gateway: Gateway): void {
  app.post("/v1/images/generations", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return respondInvalidJson(c);
    }

    const parsed = ImageRequestSchema.safeParse(fromOpenAIWireImageRequest(body));
    if (!parsed.success) {
      return respondValidation(c, parsed.error.issues);
    }

    const req = parsed.data;
    // Upstream work stops when the request times out or the client goes away.
    const signal = linkAbortSignals(new AbortController(), [c.get("abortController")?.signal, c.req.raw.signal]);
    const apiKey = c.get("apiKey");
    const ctx = {
      signal,
      traceId: c.req.header("X-Request-Id") ?? crypto.randomUUID(),
      metadata: { apiKey },
    };

    try {
      const response = await gateway.generateImageWithPlugins(ctx, {
        model: req.model,
        prompt: req.prompt,
        n: req.n,
        size: req.size,
        responseFormat: req.responseFormat,
        quality: req.quality,
        style: req.style,
        user: req.user,
      });
      return c.json(toOpenAIWireImageResponse(response), 200);
    } catch (err) {
      return respondError(c, err, signal);
    }
  });
}
