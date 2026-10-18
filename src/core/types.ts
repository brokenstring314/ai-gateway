/**
 * Pipeline types (refactor plan §1.1).
 *
 * Every endpoint is: parse wire → execute(surface, req, ctx) → render.
 * A Surface describes one API shape (chat, embeddings, images, …): how the
 * request looks to plugins, how a provider is called, where usage lives.
 * The pipeline (core/pipeline.ts) owns everything else: alias resolution,
 * before/after plugins, candidate selection, the executor, the MCP loop and
 * a single finalize per request (after/onError plugins, request log,
 * metrics, span).
 *
 * Streaming (executeStream / stream runner) builds on the same Surface,
 * RequestRun and FinalizeOutcome types: a stream run calls
 * Pipeline.finalize(run, outcome) exactly once when it ends.
 */

import type { PluginContext } from "../plugins/types.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  IProvider,
  RequestContext,
  Usage,
} from "../providers/types.js";

export type SurfaceName = "chat" | "completions" | "embeddings" | "images" | "passthrough";
export type Capability = "chat" | "embeddings" | "images" | "raw";

/** Per-request context: signal (client disconnect ∪ deadline), request id, principal metadata. */
export type RequestCtx = RequestContext;

export interface Surface<Req, Res, Chunk = never> {
  readonly name: SurfaceName;
  readonly capability: Capability;
  /** `surface` label in request logs and metrics (chat, chat_stream, embedding, image, passthrough). */
  readonly logLabel: string;
  /**
   * Candidate policy. "strategy" (chat): the strategy's targets as-is.
   * "capable" (embeddings, images): strategy targets that support the model
   * and capability, falling back to the first registered provider serving
   * the model.
   */
  readonly candidates: "strategy" | "capable";
  /** Capability name in "model does not support …" errors (capable surfaces). */
  readonly unsupportedLabel?: string;
  /** Value of plugin metadata `_surface` (unset for chat, which plugins treat as the default). */
  readonly pluginSurfaceTag?: string;
  model(req: Req): string;
  withModel(req: Req, model: string): Req;
  /** The unified view before-request plugins see (messages + model + maxTokens). */
  toPluginView(req: Req): ChatCompletionRequest;
  /** Write plugin changes back. Throw PluginRejectionError when they cannot be expressed. */
  applyPluginView(req: Req, view: ChatCompletionRequest): Req;
  /** Whether a provider can serve this surface at all. */
  supports(p: IProvider): boolean;
  call(p: IProvider, ctx: RequestCtx, req: Req): Promise<Res>;
  callStream?(p: IProvider, ctx: RequestCtx, req: Req): AsyncIterable<Chunk>;
  usage(res: Res): Usage | undefined;
  /** Chat-shaped view of a result for after-request plugins (undefined: plugins see no response). */
  toPluginResponse(res: Res, target: string): ChatCompletionResponse | undefined;
  /** Expose the raw result to after-request plugins (e.g. metadata._embeddingResponse). */
  exposeResult?(pc: PluginContext, res: Res): void;
  /** Apply an after-plugin replacement back onto the result (chat only); default keeps `res`. */
  fromPluginResponse?(res: Res, view: ChatCompletionResponse): Res;
  /** Result for a before-plugin short-circuit; undefined → the short-circuit is rejected. */
  fromShortCircuit(pc: PluginContext): Res | undefined;
  /** Error message used when a short-circuit cannot answer this surface. */
  readonly shortCircuitUnsupported?: string;
}

/** Non-streaming result of execute(). */
export interface Result<Res> {
  readonly kind: "ok";
  readonly value: Res;
  /** Target that produced the value; "none" for a plugin short-circuit. */
  readonly target: string;
  /** Usage over every upstream call made for this request (MCP rounds summed). */
  readonly usage?: Usage;
}

export type StreamEndReason = "done" | "truncated" | "upstream_error" | "idle_timeout" | "client_cancel";

export interface StreamEnd {
  readonly reason: StreamEndReason;
  readonly error?: unknown;
}

/** Streaming result of executeStream() (built by the stream runner, PR 2.5). */
export interface StreamResult<Chunk> {
  readonly kind: "stream";
  readonly first: Chunk;
  readonly rest: AsyncIterator<Chunk>;
  readonly target: string;
  /** Called once when the stream ends, errors or is cancelled; triggers finalize. */
  settle(end: StreamEnd): Promise<void>;
}

/**
 * How a request ended, for Pipeline.finalize(). Exactly one per request.
 *  - ok: upstream answered (usage summed across MCP rounds / stream);
 *  - error: no usable answer; `partial` carries what a stream delivered
 *    before failing (tokens were spent: after plugins still run);
 *  - rejected: a before plugin refused the request (no upstream call);
 *  - short_circuit: a before plugin answered the request itself.
 */
export type FinalizeOutcome<Res> =
  | {
      readonly kind: "ok";
      readonly value: Res;
      readonly target: string;
      readonly usage?: Usage;
      readonly usageEstimated?: boolean;
    }
  | {
      readonly kind: "error";
      readonly error: unknown;
      readonly target?: string;
      readonly partial?: {
        readonly response: ChatCompletionResponse;
        readonly usage: Usage;
        readonly usageEstimated?: boolean;
      };
    }
  | { readonly kind: "rejected"; readonly error: unknown; readonly plugin: string }
  | { readonly kind: "short_circuit"; readonly value: Res; readonly plugin: string };

/** State of one request between Pipeline.begin() and Pipeline.finalize(). */
export interface RequestRun<Req, Res, Chunk = never> {
  readonly surface: Surface<Req, Res, Chunk>;
  readonly ctx: RequestCtx;
  readonly startTime: number;
  /** Model as the client sent it (before alias resolution). */
  readonly requestedModel: string;
  /** Request after alias resolution and before-plugins (what goes upstream). */
  request: Req;
  readonly pluginCtx: PluginContext;
  /** Tracing span ended by finalize(). */
  readonly span?: unknown;
  /** Set once finalize() has run. */
  finalized: boolean;
}
