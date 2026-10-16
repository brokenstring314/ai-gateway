/**
 * Chat completions handler — POST /v1/chat/completions
 *
 * Supports both streaming (SSE) and non-streaming responses.
 * Validates request body with Zod, then delegates to Gateway.
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
import {
  createOpenAIWireStreamSerializer,
  fromOpenAIWireChatRequest,
  toOpenAIWireChatResponse,
} from "./openai-wire.js";

// ── Zod schemas ──

const ChatMessageSchema: z.ZodType = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "developer"]),
  content: z.union([z.string(), z.array(z.object({
    type: z.enum(["text", "image_url"]),
    text: z.string().optional(),
    imageUrl: z.object({ url: z.string(), detail: z.enum(["auto", "low", "high"]).optional() }).optional(),
  }))]).optional(),
  name: z.string().optional(),
  toolCalls: z.array(z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({ name: z.string(), arguments: z.string() }),
  })).optional(),
  toolCallId: z.string().optional(),
});

const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  maxTokens: z.number().int().positive().optional(),
  maxCompletionTokens: z.number().int().positive().optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  logitBias: z.record(z.string(), z.number()).optional(),
  user: z.string().optional(),
  seed: z.number().int().optional(),
  tools: z.array(z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
  })).optional(),
  toolChoice: z.union([
    z.enum(["none", "auto", "required"]),
    z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
  ]).optional(),
  responseFormat: z.object({
    type: z.enum(["json_object", "text", "json_schema"]),
    jsonSchema: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  parallelToolCalls: z.boolean().optional(),
  logprobs: z.boolean().optional(),
  topLogprobs: z.number().int().min(0).max(20).optional(),
  streamOptions: z.object({ includeUsage: z.boolean() }).optional(),
});

// ── SSE helpers ──

function serializeChunk(toWire: (chunk: StreamChunk) => unknown, chunk: StreamChunk): string {
  return `data: ${JSON.stringify(toWire(chunk))}\n\n`;
}

const DONE_MESSAGE = "data: [DONE]\n\n";

// ── Error response helper ──

function errorResponse(c: Context, status: ContentfulStatusCode, message: string, type: string, code?: string) {
  const error: Record<string, string> = { message, type };
  if (code) error["code"] = code;
  return c.json({ error }, status);
}

function handleGatewayError(c: Context, err: unknown) {
  if (err instanceof ProviderError) {
    return errorResponse(c, (err.statusCode || 502) as ContentfulStatusCode, err.message, "provider_error", `provider_${err.provider}`);
  }
  if (err instanceof PluginRejectionError) {
    return errorResponse(c, 403, err.reason, "plugin_rejection", "plugin_rejected");
  }
  return errorResponse(c, 500, "Internal server error", "internal_error");
}

/** Abort `controller` when any of `sources` aborts; returns its signal. */
function linkAbortSignals(controller: AbortController, sources: (AbortSignal | undefined)[]): AbortSignal {
  for (const src of sources) {
    if (!src) continue;
    if (src.aborted) {
      controller.abort(src.reason);
      break;
    }
    src.addEventListener("abort", () => controller.abort(src.reason), { once: true });
  }
  return controller.signal;
}

// ── Handler ──

export function registerChatHandler(app: AppType, gateway: Gateway): void {
  app.post("/v1/chat/completions", async (c) => {
    // Parse and validate request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, "Invalid JSON in request body", "invalid_request_error", "invalid_json");
    }

    const parsed = ChatCompletionRequestSchema.safeParse(fromOpenAIWireChatRequest(body));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return errorResponse(c, 400, `Validation error: ${issues}`, "invalid_request_error", "validation_failed");
    }

    const req = parsed.data as ChatCompletionRequest;
    // Upstream work is cancelled when the request times out, the client
    // connection goes away, or the SSE response body is cancelled.
    const upstreamAbort = new AbortController();
    const signal = linkAbortSignals(upstreamAbort, [
      c.get("abortController")?.signal,
      c.req.raw.signal,
    ]);
    const startTime = Date.now();

    const apiKey = c.get("apiKey");
    const ctx: RequestContext = {
      signal,
      traceId: c.req.header("X-Request-Id") ?? crypto.randomUUID(),
      metadata: { apiKey },
    };

    // Streaming path
    if (req.stream) {
      try {
        const stream = gateway.routeStream(ctx, req);
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

        const providerName = firstChunk?.model ?? "unknown";
        let cancelled = false;
        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              const toWire = createOpenAIWireStreamSerializer();
              try {
                if (firstChunk !== undefined) {
                  controller.enqueue(encoder.encode(serializeChunk(toWire, firstChunk)));
                }
                for await (const chunk of iterator) {
                  if (cancelled) return;
                  controller.enqueue(encoder.encode(serializeChunk(toWire, chunk)));
                }
                if (cancelled) return;
                controller.enqueue(encoder.encode(DONE_MESSAGE));
                controller.close();
              } catch (err) {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : String(err);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "stream_error" } })}\n\n`));
                controller.enqueue(encoder.encode(DONE_MESSAGE));
                controller.close();
              }
            },
            async cancel() {
              // Client went away: abort the upstream request and stop the
              // provider iterator so no more upstream tokens are produced.
              cancelled = true;
              upstreamAbort.abort();
              try {
                await iterator.return?.(undefined);
              } catch {
                // ignore
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
                "X-Gateway-Provider": providerName,
                "X-Gateway-Overhead-Ms": String(Date.now() - startTime),
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
      const response = await gateway.route(ctx, req);
      const overheadMs = Date.now() - startTime;
      const { upstreamHeaders } = response;
      return c.json(toOpenAIWireChatResponse(response), 200, mergeForwardedHeaders(
        {
          "X-Gateway-Provider": response.provider,
          "X-Gateway-Overhead-Ms": String(overheadMs),
        },
        upstreamHeaders,
      ));
    } catch (err) {
      return handleGatewayError(c, err);
    }
  });
}
