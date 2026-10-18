/**
 * Embeddings handler — POST /v1/embeddings
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppType } from "../app.js";
import type { Gateway } from "../gateway.js";
import { toOpenAIWireEmbeddingResponse } from "./openai-wire.js";
import { ProviderError } from "../providers/openai-compat.js";
import { PluginRejectionError } from "../plugins/error.js";
import { isTimeoutAbort, isTimeoutError } from "../routing/outcome.js";

const EmbeddingRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});

function errorResponse(c: Context, status: ContentfulStatusCode, message: string, type: string, code?: string) {
  const error: Record<string, string> = { message, type };
  if (code) error["code"] = code;
  return c.json({ error }, status);
}

export function registerEmbeddingsHandler(app: AppType, gateway: Gateway): void {
  app.post("/v1/embeddings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON in request body", "invalid_request_error", "invalid_json");
    }

    const parsed = EmbeddingRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return errorResponse(c, 400, `Validation error: ${issues}`, "invalid_request_error", "validation_failed");
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
      // The gateway's own request timeout fired (AbortError, TimeoutError or
      // any error the provider surfaced after the abort): 504, like chat.
      if (isTimeoutAbort(signal) || isTimeoutError(err)) {
        return errorResponse(c, 504, "Upstream request timed out", "timeout_error", "gateway_timeout");
      }
      if (err instanceof PluginRejectionError) {
        return errorResponse(c, 403, err.reason, "plugin_rejection", "plugin_rejected");
      }
      if (err instanceof ProviderError) {
        const upstream = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502;
        return errorResponse(c, upstream as ContentfulStatusCode, err.message, "provider_error", `provider_${err.provider}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      const status: ContentfulStatusCode = message.includes("No provider found") ? 404
        : message.includes("does not support") ? 400
        : 500;
      return errorResponse(c, status, message, "embedding_error");
    }
  });
}
