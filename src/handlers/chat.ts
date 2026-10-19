/**
 * Chat completions handler — POST /v1/chat/completions
 *
 * Supports both streaming (SSE) and non-streaming responses.
 * Validates request body with Zod, then delegates to Gateway.
 */

import { z } from "zod";
import type { AppType } from "../app.js";
import { respondError, respondInvalidJson, respondValidation } from "./error-response.js";
import type { Gateway } from "../gateway.js";
import type { ChatCompletionRequest } from "../providers/types.js";
import { mergeForwardedHeaders } from "../providers/response-headers.js";
import { handlerRequest, respondSse } from "./request.js";
import {
  createOpenAIWireStreamSerializer,
  attachWireRequestExtras,
  fromOpenAIWireChatRequest,
  toOpenAIWireChatResponse,
} from "./openai-wire.js";

// ── Zod schemas ──

const ChatMessageSchema: z.ZodType = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "developer"]),
  content: z
    .union([
      z.string(),
      z.array(
        z.union([
          z.object({
            type: z.enum(["text", "image_url"]),
            text: z.string().optional(),
            imageUrl: z.object({ url: z.string(), detail: z.enum(["auto", "low", "high"]).optional() }).optional(),
          }),
          // Other OpenAI part types (input_audio, file, refusal …), forwarded verbatim.
          z.object({ type: z.enum(["input_audio", "file", "refusal"]), raw: z.record(z.string(), z.unknown()) }),
        ]),
      ),
    ])
    .optional(),
  name: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
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
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
          strict: z.boolean().optional(),
        }),
      }),
    )
    .optional(),
  toolChoice: z
    .union([
      z.enum(["none", "auto", "required"]),
      z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  responseFormat: z
    .object({
      type: z.enum(["json_object", "text", "json_schema"]),
      jsonSchema: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  parallelToolCalls: z.boolean().optional(),
  logprobs: z.boolean().optional(),
  topLogprobs: z.number().int().min(0).max(20).optional(),
  streamOptions: z.object({ includeUsage: z.boolean() }).optional(),
});

// ── Handler ──

export function registerChatHandler(app: AppType, gateway: Gateway): void {
  app.post("/v1/chat/completions", async (c) => {
    // Parse and validate request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return respondInvalidJson(c);
    }

    const parsed = ChatCompletionRequestSchema.safeParse(fromOpenAIWireChatRequest(body));
    if (!parsed.success) {
      return respondValidation(c, parsed.error.issues);
    }

    // Allow-listed fields the schema does not model (reasoning_effort, store,
    // message reasoning_content …) are forwarded upstream verbatim (T3-11).
    const req = attachWireRequestExtras(body, parsed.data as ChatCompletionRequest);
    const hr = handlerRequest(c);
    const { ctx } = hr;
    const startTime = Date.now();

    if (req.stream) {
      return respondSse(c, gateway, hr, gateway.routeStream(ctx, req), {
        serialize: createOpenAIWireStreamSerializer(),
        headers: () => ({
          "X-Gateway-Provider": ctx.servedTarget ?? "unknown",
          "X-Gateway-Overhead-Ms": String(Date.now() - startTime),
        }),
      });
    }

    // Non-streaming path
    try {
      const response = await gateway.route(ctx, req);
      const overheadMs = Date.now() - startTime;
      const { upstreamHeaders } = response;
      return c.json(
        toOpenAIWireChatResponse(response),
        200,
        mergeForwardedHeaders(
          {
            "X-Gateway-Provider": response.provider,
            "X-Gateway-Overhead-Ms": String(overheadMs),
          },
          upstreamHeaders,
        ),
      );
    } catch (err) {
      return respondError(c, err);
    }
  });
}
