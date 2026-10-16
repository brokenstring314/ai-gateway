/**
 * Legacy completions handler — POST /v1/completions
 *
 * Wraps the legacy completions format into a chat completion request
 * and delegates to the Gateway.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppType } from "../app.js";
import type { Gateway } from "../gateway.js";
import type { ChatCompletionRequest, RequestContext, StreamChunk } from "../providers/types.js";
import { mergeForwardedHeaders } from "../providers/response-headers.js";
import { ProviderError } from "../providers/openai-compat.js";
import { PluginRejectionError } from "../plugins/error.js";
import { isTimeoutAbort, isTimeoutError } from "../routing/outcome.js";

const CompletionsRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.union([z.string(), z.array(z.string())]),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  maxTokens: z.number().int().positive().optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  logitBias: z.record(z.string(), z.number()).optional(),
  user: z.string().optional(),
  seed: z.number().int().optional(),
  logprobs: z.boolean().optional(),
  topLogprobs: z.number().int().min(0).max(20).optional(),
});

function errorResponse(c: Context, status: ContentfulStatusCode, message: string, type: string, code?: string) {
  const error: Record<string, string> = { message, type };
  if (code) error["code"] = code;
  return c.json({ error }, status);
}

function handleGatewayError(c: Context, err: unknown) {
  // The gateway's own request timeout fired (whatever error it surfaced as:
  // AbortError, a 504 ProviderError, fallback exhaustion): answer 504.
  if (isTimeoutAbort(c.get("abortController")?.signal) || isTimeoutError(err)) {
    return errorResponse(c, 504, "Upstream request timed out", "timeout_error", "gateway_timeout");
  }
  if (err instanceof ProviderError) {
    return errorResponse(c, (err.statusCode || 502) as ContentfulStatusCode, err.message, "provider_error", `provider_${err.provider}`);
  }
  if (err instanceof PluginRejectionError) {
    return errorResponse(c, 403, err.reason, "plugin_rejection", "plugin_rejected");
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(c, 500, message, "internal_error");
}

/** Convert legacy completions prompt to chat messages format. */
function promptToMessages(prompt: string | string[]): { role: "user"; content: string }[] {
  if (typeof prompt === "string") {
    return [{ role: "user" as const, content: prompt }];
  }
  return prompt.map((p) => ({ role: "user" as const, content: p }));
}

export function registerCompletionsHandler(app: AppType, gateway: Gateway): void {
  app.post("/v1/completions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON in request body", "invalid_request_error", "invalid_json");
    }

    const parsed = CompletionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return errorResponse(c, 400, `Validation error: ${issues}`, "invalid_request_error", "validation_failed");
    }

    const legacy = parsed.data;

    // Convert to chat completion request
    const chatReq: ChatCompletionRequest = {
      model: legacy.model,
      messages: promptToMessages(legacy.prompt),
      temperature: legacy.temperature,
      topP: legacy.topP,
      n: legacy.n,
      stream: legacy.stream,
      stop: legacy.stop,
      maxTokens: legacy.maxTokens,
      presencePenalty: legacy.presencePenalty,
      frequencyPenalty: legacy.frequencyPenalty,
      logitBias: legacy.logitBias,
      user: legacy.user,
      seed: legacy.seed,
      logprobs: legacy.logprobs,
      topLogprobs: legacy.topLogprobs,
    };

    const signal = c.get("abortController")?.signal;
    const apiKey = c.get("apiKey");
    const ctx: RequestContext = {
      signal,
      traceId: c.req.header("X-Request-Id") ?? crypto.randomUUID(),
      metadata: { apiKey },
    };

    // Streaming path
    if (legacy.stream) {
      try {
        const stream = gateway.routeStream(ctx, chatReq);
        const iterator = stream[Symbol.asyncIterator]();

        // Prime the generator so the provider's upstream fetch completes and
        // any forwardable upstream headers are published on the context before
        // the SSE Response is constructed (headers must be fixed at
        // construction time).
        let firstChunk: StreamChunk | undefined;
        try {
          const first = await iterator.next();
          if (!first.done) {
            firstChunk = first.value;
          }
        } catch (err) {
          return handleGatewayError(c, err);
        }

        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              try {
                if (firstChunk !== undefined) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstChunk)}\n\n`));
                }
                for await (const chunk of iterator) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "stream_error" } })}\n\n`));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }
            },
          }),
          {
            status: 200,
            headers: mergeForwardedHeaders(
              {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              },
              ctx.upstreamHeaders,
            ),
          },
        );
      } catch (err) {
        return handleGatewayError(c, err);
      }
    }

    // Non-streaming path
    try {
      const response = await gateway.route(ctx, chatReq);
      const { upstreamHeaders, ...responseBody } = response;
      return c.json(responseBody, 200, mergeForwardedHeaders({}, upstreamHeaders));
    } catch (err) {
      return handleGatewayError(c, err);
    }
  });
}
