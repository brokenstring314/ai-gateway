/**
 * Streaming execution for chat-shaped surfaces (chat, completions):
 * Pipeline.executeStream(surface, req, ctx).
 *
 * Before plugins, candidates and the single finalize come from the
 * pipeline; the after-request plugins, the request log and the metrics see
 * the streamed request exactly once, however it ends: normal completion,
 * upstream error, or the client going away (generator return()). The
 * provider always asks the upstream for a usage chunk (stream_options
 * .include_usage); when the client did not ask for one, usage is metered but
 * kept off the client stream (a usage-only chunk is dropped, a usage field on
 * a content chunk removed), so the client stream is unchanged. Only an upstream that sends no usage at all is estimated
 * (core/usage.ts estimateTextTokens, CJK-aware) so a quota is not bypassed.
 *
 * Breaker, limiter, retry and failover before the first chunk:
 * core/executor.ts; first chunk, StreamEnd and settle-once:
 * core/stream-runner.ts; finalize-once: core/pipeline.ts.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  IProvider,
  RequestContext,
  StreamChunk,
} from "../providers/types.js";
import { CircuitOpenError } from "../routing/circuit-breaker.js";
import { ConcurrencyLimitError } from "../routing/concurrency-limiter.js";
import type { ModelRoute } from "../routing/model-catalog.js";
import { toGatewayError } from "./errors.js";
import { strategyRunOptions, type TargetExecutor } from "./executor.js";
import type { Pipeline } from "./pipeline.js";
import { executeStream, iterateStream, type StreamPlan } from "./stream-runner.js";
import type { StreamEnd, Surface } from "./types.js";
import { accumulateChunk, estimateStreamUsage, newStreamAccumulator, resolveUsage } from "./usage.js";

export type ChatShapedSurface = Surface<ChatCompletionRequest, ChatCompletionResponse, StreamChunk>;

const STREAM_SHORT_CIRCUIT_UNSUPPORTED =
  "Plugin short-circuited during streaming request; short-circuit is not supported for streaming";

const streamVariants = new WeakMap<ChatShapedSurface, ChatShapedSurface>();

/** The streaming variant of a surface: `<label>_stream` in logs, and a plugin short-circuit is rejected. */
export function streamSurfaceOf(surface: ChatShapedSurface): ChatShapedSurface {
  let variant = streamVariants.get(surface);
  if (!variant) {
    variant = {
      ...surface,
      logLabel: `${surface.logLabel}_stream`,
      fromShortCircuit: () => undefined,
      shortCircuitUnsupported: STREAM_SHORT_CIRCUIT_UNSUPPORTED,
    };
    streamVariants.set(surface, variant);
  }
  return variant;
}

/** Stream plan over the model's bound targets, opening each through the surface (model renamed per binding). */
export function surfaceStreamPlan(
  pipeline: Pipeline,
  executor: TargetExecutor,
  route: ModelRoute,
  surface: ChatShapedSurface,
  ctx: RequestContext,
  req: ChatCompletionRequest,
): StreamPlan<StreamChunk> {
  const candidates = route.strategy.selectTargets(req);
  const open = surface.callStream;
  if (!open) throw new Error(`surface ${surface.name} does not stream`);
  return {
    executor,
    candidates,
    open: (p: IProvider) => open(p, ctx, pipeline.forTarget(surface, req, route, p.name)),
    run: strategyRunOptions(route.strategy, true, candidates.length),
  };
}

/**
 * Stream a chat-shaped request through the pipeline. MCP tools are NOT
 * injected on the streaming path: there is no agentic loop here, so
 * injected tools would surface to the client as tool_calls for tools it
 * never declared and cannot execute.
 */
export async function* runChatStream(
  pipeline: Pipeline,
  executor: TargetExecutor,
  baseSurface: ChatShapedSurface,
  req: ChatCompletionRequest,
  ctx: RequestContext,
): AsyncGenerator<StreamChunk> {
  const surface = streamSurfaceOf(baseSurface);
  const begun = await pipeline.begin(surface, req, ctx);
  // A stream surface never accepts a short-circuit (begin() rejects it).
  if (begun.kind !== "proceed") return;
  const { run } = begun;
  const finalReq = run.request;
  const acc = newStreamAccumulator(finalReq.model);
  const finalize = async (end: StreamEnd, target: string | undefined): Promise<void> => {
    const streamError = streamErrorOf(end, acc.chunks);
    // No usage chunk, or an implausible one (RB1): estimated.
    const { usage, estimated: usageEstimated } = resolveUsage(acc.usage, () => estimateStreamUsage(finalReq, acc));
    const response: ChatCompletionResponse = {
      id: acc.id,
      object: "chat.completion",
      created: acc.created,
      model: acc.model,
      provider: target ?? "unknown",
      choices: [{ index: 0, message: { role: "assistant", content: acc.content }, finishReason: acc.finishReason }],
      usage,
      metadata: usageEstimated ? { usageEstimated: true } : undefined,
    };
    if (streamError === undefined) {
      await pipeline.finalize(run, { kind: "ok", value: response, target: target ?? "unknown", usage, usageEstimated });
    } else if (acc.chunks === 0) {
      // No chunk: nothing streamed, but a call the upstream received before
      // the client left / the request timed out still costs its prompt (F2).
      const aborted = pipeline.abortedCallUsage(surface, finalReq, ctx);
      await pipeline.finalize(run, {
        kind: "error",
        error: streamError,
        target,
        ...(aborted ? { metered: { usage: aborted, usageEstimated: true } } : {}),
      });
    } else {
      await pipeline.finalize(run, {
        kind: "error",
        error: streamError,
        target,
        partial: { response, usage, usageEstimated },
      });
    }
  };
  let result: Awaited<ReturnType<typeof executeStream<StreamChunk>>>;
  try {
    const plan = surfaceStreamPlan(pipeline, executor, pipeline.route(finalReq.model), surface, ctx, finalReq);
    result = await executeStream(ctx, plan, { mapError: toPipelineError, finalize });
    if (ctx) ctx.servedTarget = result.target;
  } catch (err) {
    // e.g. strategy selection failed before executeStream could settle.
    await pipeline.finalize(run, { kind: "error", error: err });
    throw err;
  }
  const clientWantsUsage = finalReq.streamOptions?.includeUsage === true;
  // Every chunk carries the published model name, never the binding's
  // upstream id (B3); the accumulator keeps the upstream's for the log.
  const published = finalReq.model;
  for await (const upstreamChunk of iterateStream(result, ctx?.signal, toPipelineError)) {
    accumulateChunk(acc, upstreamChunk);
    const chunk =
      published !== "" && upstreamChunk.model !== published ? { ...upstreamChunk, model: published } : upstreamChunk;
    if (!clientWantsUsage && chunk.usage !== undefined) {
      // Metered above; the client did not ask for usage. Some upstreams
      // (DeepSeek) put it on the last content chunk, others on a usage-only
      // chunk (choices: []), which is dropped.
      if (isUsageOnlyChunk(chunk)) continue;
      const { usage: _usage, ...rest } = chunk;
      yield rest;
      continue;
    }
    yield chunk;
  }
}

/** The trailing usage chunk of an include_usage stream: usage and no choices. */
function isUsageOnlyChunk(chunk: StreamChunk): boolean {
  return chunk.usage !== undefined && (chunk.choices?.length ?? 0) === 0;
}

/**
 * The error finalize records for a stream end: none for a completed stream
 * or a client that went away after output; otherwise the end's error.
 */
function streamErrorOf(end: StreamEnd, chunks: number): Error | undefined {
  if (end.reason === "done") return undefined;
  if (end.reason === "client_cancel" && chunks > 0 && end.error === undefined) return undefined;
  const err = end.error ?? new Error(`stream ended: ${end.reason}`);
  return err instanceof Error ? err : new Error(String(err));
}

/** Breaker-open / queue-full errors as GatewayErrors (HTTP 503 / 429). */
function toPipelineError(err: unknown): unknown {
  return err instanceof CircuitOpenError || err instanceof ConcurrencyLimitError ? toGatewayError(err) : err;
}
