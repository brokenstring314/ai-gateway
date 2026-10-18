/**
 * Shared per-request plumbing for the API handlers: the RequestContext
 * (abort signal, trace id, principal) and the primed SSE response.
 */

import type { Context } from "hono";
import type { AppEnv } from "../app.js";
import type { Gateway } from "../gateway.js";
import { mergeForwardedHeaders } from "../providers/response-headers.js";
import type { RequestContext, StreamChunk } from "../providers/types.js";
import { linkAbortSignals } from "./abort.js";
import { respondError } from "./error-response.js";
import { heartbeatIntervalMs } from "./sse-heartbeat.js";
import { createSseStream, streamIdleTimeoutMs, streamMaxDurationMs } from "./sse-stream.js";

export interface HandlerRequest {
  readonly ctx: RequestContext;
  /** Aborted when the request times out, the client goes away, or the SSE body is cancelled. */
  readonly upstreamAbort: AbortController;
}

type AnyContext = Context<AppEnv>;

/** Request context linked to the request deadline and the client connection. */
export function handlerRequest(c: AnyContext): HandlerRequest {
  const upstreamAbort = new AbortController();
  const signal = linkAbortSignals(upstreamAbort, [c.get("abortController")?.signal, c.req.raw.signal]);
  const ctx: RequestContext = {
    signal,
    traceId: c.req.header("X-Request-Id") ?? crypto.randomUUID(),
    metadata: { apiKey: c.get("apiKey") },
  };
  return { ctx, upstreamAbort };
}

export interface SseResponseOptions {
  readonly serialize: (chunk: StreamChunk) => unknown;
  /** Extra response headers, computed once the first chunk is known. */
  readonly headers?: (firstChunk: StreamChunk | undefined) => Record<string, string>;
}

/**
 * Prime the stream (so the upstream fetch completes and forwardable upstream
 * headers are on the context before the Response is built: headers are fixed
 * at construction) and answer it as SSE. An error before the first chunk is
 * answered as a normal JSON error.
 */
export async function respondSse(
  c: AnyContext,
  gateway: Gateway,
  req: HandlerRequest,
  stream: AsyncIterable<StreamChunk>,
  opts: SseResponseOptions,
): Promise<Response> {
  try {
    const iterator = stream[Symbol.asyncIterator]();
    let firstChunk: StreamChunk | undefined;
    try {
      const first = await iterator.next();
      if (!first.done) firstChunk = first.value;
    } catch (err) {
      return respondError(c, err);
    }
    const serverCfg = gateway.getConfig?.()?.server;
    return new Response(
      createSseStream<StreamChunk>({
        iterator,
        firstChunk,
        serialize: opts.serialize,
        upstreamAbort: req.upstreamAbort,
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
            ...opts.headers?.(firstChunk),
          },
          req.ctx.upstreamHeaders,
        ),
      },
    );
  } catch (err) {
    return respondError(c, err);
  }
}
