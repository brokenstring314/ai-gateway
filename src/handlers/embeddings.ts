/**
 * Embeddings handler — POST /v1/embeddings
 */

import { z } from "zod";
import type { AppType } from "../app.js";
import { respondError, respondInvalidJson, respondValidation } from "./error-response.js";
import type { Gateway } from "../gateway.js";
import { dropNullFields, toOpenAIWireEmbeddingResponse } from "./openai-wire.js";
import { handlerRequest } from "./request.js";

const EmbeddingRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
  dimensions: z.number().int().positive().optional(),
  encoding_format: z.enum(["float", "base64"]).optional(),
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

    const parsed = EmbeddingRequestSchema.safeParse(dropNullFields(body));
    if (!parsed.success) {
      return respondValidation(c, parsed.error.issues);
    }

    const req = parsed.data;
    // Upstream work stops when the request times out or the client goes away.
    const { ctx } = handlerRequest(c);
    const { signal } = ctx;

    try {
      const response = await gateway.embedWithPlugins(ctx, {
        model: req.model,
        input: req.input,
        dimensions: req.dimensions,
        encodingFormat: req.encoding_format,
        user: req.user,
      });
      return c.json(toOpenAIWireEmbeddingResponse(response), 200);
    } catch (err) {
      return respondError(c, err, signal);
    }
  });
}
