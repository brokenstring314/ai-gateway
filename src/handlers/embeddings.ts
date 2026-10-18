/**
 * Embeddings handler — POST /v1/embeddings
 */

import { z } from "zod";
import type { AppType } from "../app.js";
import { respondError, respondInvalidJson, respondValidation } from "./error-response.js";
import type { Gateway } from "../gateway.js";
import { toOpenAIWireEmbeddingResponse } from "./openai-wire.js";

const EmbeddingRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});


export function registerEmbeddingsHandler(app: AppType, gateway: Gateway): void {
  app.post("/v1/embeddings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return respondInvalidJson(c);
    }

    const parsed = EmbeddingRequestSchema.safeParse(body);
    if (!parsed.success) {
      return respondValidation(c, parsed.error.issues);
    }

    const req = parsed.data;
    const signal = c.get("abortController")?.signal;
    const apiKey = c.get("apiKey");
    const ctx = {
      signal,
      traceId: c.req.header("X-Request-Id") ?? crypto.randomUUID(),
      metadata: { apiKey },
    };

    try {
      const response = await gateway.embedWithPlugins(ctx, {
        model: req.model,
        input: req.input,
        dimensions: req.dimensions,
        user: req.user,
      });
      return c.json(toOpenAIWireEmbeddingResponse(response), 200);
    } catch (err) {
      return respondError(c, err, signal);
    }
  });
}
