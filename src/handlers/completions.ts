/**
 * Legacy completions handler — POST /v1/completions
 *
 * Wraps the legacy completions format into a chat completion request
 * and delegates to the Gateway.
 */

import { z } from "zod";
import type { AppType } from "../app.js";
import { respondError, respondInvalidJson, respondValidation } from "./error-response.js";
import type { Gateway } from "../gateway.js";
import type { ChatCompletionRequest, RequestContext, StreamChunk } from "../providers/types.js";
import { mergeForwardedHeaders } from "../providers/response-headers.js";
import { heartbeatIntervalMs } from "./sse-heartbeat.js";
import { createSseStream, streamIdleTimeoutMs, streamMaxDurationMs } from "./sse-stream.js";
import { linkAbortSignals } from "./abort.js";

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
      return respondInvalidJson(c);
    }

    const parsed = CompletionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return respondValidation(c, parsed.error.issues);
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

    // Upstream work is cancelled when the request times out, the client
    // connection goes away, or the SSE response body is cancelled.
    const upstreamAbort = new AbortController();
    const signal = linkAbortSignals(upstreamAbort, [
      c.get("abortController")?.signal,
      c.req.raw.signal,
    ]);
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
          return respondError(c, err);
        }

        const serverCfg = gateway.getConfig?.()?.server;
        return new Response(
          createSseStream<StreamChunk>({
            iterator,
            firstChunk,
            serialize: (chunk) => chunk,
            upstreamAbort,
            heartbeatMs: heartbeatIntervalMs(serverCfg?.sseHeartbeatSeconds),
            idleTimeoutMs: streamIdleTimeoutMs(serverCfg?.streamIdleTimeoutSeconds),
            maxDurationMs: streamMaxDurationMs(serverCfg?.streamMaxDurationSeconds),
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
        return respondError(c, err);
      }
    }

    // Non-streaming path
    try {
      const response = await gateway.route(ctx, chatReq);
      const { upstreamHeaders, ...responseBody } = response;
      return c.json(responseBody, 200, mergeForwardedHeaders({}, upstreamHeaders));
    } catch (err) {
      return respondError(c, err);
    }
  });
}
