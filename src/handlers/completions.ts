/**
 * Legacy completions handler — POST /v1/completions
 *
 * Maps the legacy completions wire format onto a chat completion request,
 * delegates to the Gateway, and answers in the OpenAI `text_completion`
 * shape (core/surfaces/completions.ts).
 */

import type { AppType } from "../app.js";
import { respondError, respondInvalidJson, respondValidation } from "./error-response.js";
import type { Gateway } from "../gateway.js";
import type { RequestContext, StreamChunk } from "../providers/types.js";
import {
  createTextCompletionStreamSerializer,
  parseCompletionsRequest,
  toTextCompletionResponse,
} from "../core/surfaces/completions.js";
import { mergeForwardedHeaders } from "../providers/response-headers.js";
import { heartbeatIntervalMs } from "./sse-heartbeat.js";
import { createSseStream, streamIdleTimeoutMs, streamMaxDurationMs } from "./sse-stream.js";
import { linkAbortSignals } from "./abort.js";

export function registerCompletionsHandler(app: AppType, gateway: Gateway): void {
  app.post("/v1/completions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return respondInvalidJson(c);
    }

    // snake_case wire params (max_tokens, top_p …) mapped onto the chat
    // request the pipeline runs; legacy-only options chat can't express → 400.
    const parsed = parseCompletionsRequest(body);
    if (!parsed.ok) {
      return respondValidation(c, parsed.issues);
    }
    const chatReq = parsed.request;

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
    if (chatReq.stream) {
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
            serialize: createTextCompletionStreamSerializer(),
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
      return c.json(toTextCompletionResponse(response), 200, mergeForwardedHeaders({}, response.upstreamHeaders));
    } catch (err) {
      return respondError(c, err);
    }
  });
}
