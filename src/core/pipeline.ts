/**
 * The request pipeline (refactor plan §1.1): execute(surface, req, ctx).
 *
 *   1 normalize  alias resolution
 *   2 before     plugins.runBefore — reject / short-circuit → finalize
 *   3 prepare    surface.applyPluginView; MCP tool injection (chat)
 *   4 select     strategy.selectTargets → candidates (capable surfaces filter)
 *   5 attempt    TargetExecutor: breaker → limiter → call → classify → failover
 *   6 mcpLoop    chat with gateway-owned tool_calls: every round through 5,
 *                usage summed
 *   7 finalize   exactly once per request: after/onError plugins → settled
 *                callbacks (budget release) → request log (console + sinks)
 *                → metrics (tokens, cost, plugin blocked) → span end
 *
 * Streaming (executeStream → core/chat-stream.ts) reuses begin() /
 * finalize(): a stream run calls finalize(run, outcome) once when it ends.
 */

import type { TargetConfig } from "../config/types.js";
import { getMetrics } from "../metrics/metrics.js";
import { getTracer } from "../observability/otel-tracer.js";
import { getRequestLogger, type RequestLogEntry } from "../observability/request-log.js";
import { createPluginContext, settlePluginContext, type InternalPluginContext } from "../plugins/context.js";
import { PluginRejectionError } from "../plugins/error.js";
import type { PluginManager } from "../plugins/manager.js";
import type { ChatCompletionRequest, IProvider, RequestContext, StreamChunk, Usage } from "../providers/types.js";
import { CircuitOpenError } from "../routing/circuit-breaker.js";
import { ConcurrencyLimitError } from "../routing/concurrency-limiter.js";
import type { IStrategy } from "../routing/types.js";
import { invalidRequest, modelNotFound, toGatewayError } from "./errors.js";
import { strategyRunOptions, type TargetExecutor } from "./executor.js";
import type { McpLoop } from "./mcp-loop.js";
import { runChatStream, type ChatShapedSurface } from "./chat-stream.js";
import type { FinalizeOutcome, RequestRun, Result, Surface } from "./types.js";
import { addUsage, costOf } from "./usage.js";

/** Provider label for requests that never reached an upstream target. */
export const NO_UPSTREAM_PROVIDER = "none";

/** Root span names (chat keeps its historical names). */
const SPAN_NAMES: Readonly<Record<string, string>> = { chat: "gateway.route", chat_stream: "gateway.routeStream" };

/** Receives every request-log entry (e.g. the SQLite request log store). Must not throw. */
export type RequestLogSink = (entry: RequestLogEntry) => void;

export interface PipelineDeps {
  readonly plugins: PluginManager;
  readonly strategy: IStrategy;
  readonly executor: TargetExecutor;
  readonly lookup: (name: string) => IProvider | undefined;
  readonly findByModel: (model: string) => IProvider | undefined;
  readonly aliases: Readonly<Record<string, string>>;
  readonly strategyLabel: string;
  readonly targetConfig: (name: string) => TargetConfig | undefined;
  readonly mcp: () => McpLoop | null;
  readonly logSinks: () => Iterable<RequestLogSink>;
}

/** begin(): either a run to send upstream, or the request is already answered by a plugin. */
export type Begun<Req, Res, Chunk> =
  | { readonly kind: "proceed"; readonly run: RequestRun<Req, Res, Chunk> }
  | { readonly kind: "answered"; readonly run: RequestRun<Req, Res, Chunk>; readonly value: Res };

export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  /** Non-streaming request through the whole pipeline. */
  async execute<Req, Res, Chunk>(
    surface: Surface<Req, Res, Chunk>,
    req: Req,
    ctx: RequestContext,
  ): Promise<Result<Res>> {
    const begun = await this.begin(surface, req, ctx);
    if (begun.kind === "answered") return { kind: "ok", value: begun.value, target: NO_UPSTREAM_PROVIDER };
    const { run } = begun;
    let target: string | undefined;
    try {
      let request = run.request;
      // Chat-capable surfaces (chat, completions) run the MCP agentic loop.
      const mcp = surface.capability === "chat" ? this.deps.mcp() : null;
      if (mcp) request = mcp.inject(request as never) as Req;
      const first = await this.attempt(surface, request, ctx);
      target = first.target;
      let value = first.value;
      let usage = surface.usage(value);
      if (mcp) {
        const looped = await mcp.run(ctx, request as never, value as never, async (c, r) => {
          const next = await this.attempt(surface, r as unknown as Req, c);
          target = next.target;
          return next.value as never;
        });
        value = looped.response as Res;
        usage = looped.usage;
      }
      value = await this.finalize(run, { kind: "ok", value, target, usage });
      return { kind: "ok", value, target, usage };
    } catch (err) {
      await this.finalize(run, { kind: "error", error: err, target });
      throw err;
    }
  }

  /** Streaming chat-shaped request (chat, completions) through the pipeline: core/chat-stream.ts. */
  executeStream(
    surface: ChatShapedSurface,
    req: ChatCompletionRequest,
    ctx: RequestContext,
  ): AsyncGenerator<StreamChunk> {
    return runChatStream(this, this.deps.executor, this.deps.strategy, surface, req, ctx);
  }

  /**
   * Steps 1–3: alias, before plugins, plugin view written back. A plugin
   * rejection is finalized and rethrown; a short-circuit is finalized and
   * returned as "answered" (or rejected when the surface cannot use it).
   */
  async begin<Req, Res, Chunk>(
    surface: Surface<Req, Res, Chunk>,
    req: Req,
    ctx: RequestContext,
  ): Promise<Begun<Req, Res, Chunk>> {
    const startTime = Date.now();
    const requestedModel = surface.model(req);
    const resolved = surface.withModel(req, this.deps.aliases[requestedModel] ?? requestedModel);
    const pluginCtx = createPluginContext(surface.toPluginView(resolved), ctx);
    if (surface.pluginSurfaceTag) pluginCtx.metadata["_surface"] = surface.pluginSurfaceTag;
    const span = getTracer().startSpan(SPAN_NAMES[surface.logLabel] ?? `gateway.${surface.logLabel}`, {
      "request.model": requestedModel,
    });
    const run: RequestRun<Req, Res, Chunk> = {
      surface,
      ctx,
      startTime,
      requestedModel,
      request: resolved,
      pluginCtx,
      finalized: false,
      span,
    };

    try {
      await this.deps.plugins.runBefore(pluginCtx);
    } catch (err) {
      if (err instanceof PluginRejectionError) {
        await this.finalize(run, { kind: "rejected", error: err, plugin: err.plugin ?? "unknown" });
      } else {
        await this.finalize(run, { kind: "error", error: err });
      }
      throw err;
    }

    if (pluginCtx._shortCircuited) {
      const plugin = pluginCtx._shortCircuitedBy ?? "unknown";
      const value = surface.fromShortCircuit(pluginCtx);
      if (value !== undefined) {
        await this.finalize(run, { kind: "short_circuit", value, plugin });
        return { kind: "answered", run, value };
      }
      const rejection = new PluginRejectionError(
        "before_request",
        surface.shortCircuitUnsupported ?? "Plugin short-circuited the request without supplying a response",
        pluginCtx._shortCircuitedBy,
      );
      await this.finalize(run, { kind: "rejected", error: rejection, plugin });
      throw rejection;
    }

    try {
      run.request = surface.applyPluginView(resolved, pluginCtx.request);
    } catch (err) {
      const plugin =
        (err instanceof PluginRejectionError ? err.plugin : undefined) ?? pluginCtx._modifiedBy?.join(",") ?? "unknown";
      await this.finalize(
        run,
        err instanceof PluginRejectionError ? { kind: "rejected", error: err, plugin } : { kind: "error", error: err },
      );
      throw err;
    }
    return { kind: "proceed", run };
  }

  /** Step 4: ordered candidate targets for a request. */
  candidates<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req): readonly string[] {
    const model = surface.model(req);
    if (surface.candidates === "strategy") {
      return this.deps.strategy.selectTargets(surface.toPluginView(req));
    }
    let ordered: readonly string[] = [];
    try {
      ordered = this.deps.strategy.selectTargets({ model, messages: [] });
    } catch {
      ordered = [];
    }
    const candidates = [...new Set(ordered)].filter((name) => {
      const p = this.deps.lookup(name);
      return !!p && surface.supports(p) && p.supportsModel(model);
    });
    if (candidates.length > 0) return candidates;
    const provider = this.deps.findByModel(model);
    if (!provider) throw modelNotFound(`No provider found for ${surface.logLabel} model "${model}"`);
    if (!surface.supports(provider)) {
      throw invalidRequest(
        `The model "${model}" does not support ${surface.unsupportedLabel ?? surface.name}`,
        "unsupported_capability",
      );
    }
    return [provider.name];
  }

  /** Step 5: one upstream call over the candidates (breaker, limiter, retry, failover). */
  async attempt<Req, Res, Chunk>(
    surface: Surface<Req, Res, Chunk>,
    req: Req,
    ctx: RequestContext,
  ): Promise<{ value: Res; target: string }> {
    const candidates = this.candidates(surface, req);
    let target = candidates[0] ?? "unknown";
    const onServed = (name: string) => {
      target = name;
    };
    const opts =
      surface.candidates === "strategy"
        ? strategyRunOptions(this.deps.strategy, false, candidates.length, onServed)
        : { label: `Gateway(${surface.logLabel})`, supports: (p: IProvider) => surface.supports(p), onServed };
    try {
      const value = await this.deps.executor.run(ctx, candidates, (p) => surface.call(p, ctx, req), opts);
      return { value, target };
    } catch (err) {
      if (err instanceof ConcurrencyLimitError || err instanceof CircuitOpenError) throw toGatewayError(err);
      throw err;
    }
  }

  /**
   * Step 7, exactly once per request (later calls are no-ops and return the
   * value unchanged). Returns the value after-request plugins left (chat
   * plugins may replace the response). An after-plugin error is logged with
   * the request and rethrown.
   */
  async finalize<Req, Res, Chunk>(run: RequestRun<Req, Res, Chunk>, outcome: FinalizeOutcome<Res>): Promise<Res> {
    const passthrough = (outcome.kind === "ok" || outcome.kind === "short_circuit" ? outcome.value : undefined) as Res;
    if (run.finalized) return passthrough;
    run.finalized = true;

    const { surface, ctx } = run;
    const pc = run.pluginCtx as InternalPluginContext;
    let value = passthrough;
    let usage: Usage | undefined;
    let usageEstimated = false;
    let target: string = NO_UPSTREAM_PROVIDER;
    let model = run.requestedModel;
    let error: unknown;
    let pluginError: unknown;

    try {
      if (outcome.kind === "ok") {
        target = outcome.target;
        usage = outcome.usage ?? surface.usage(outcome.value);
        usageEstimated = outcome.usageEstimated === true;
        surface.exposeResult?.(pc, outcome.value);
        this.exposeCost(pc, target, usage);
        const view = surface.toPluginResponse(outcome.value, target);
        pc.response = view && usage && view.usage !== usage ? { ...view, usage } : view;
        await this.deps.plugins.runAfter(pc);
        if (surface.fromPluginResponse && pc.response) value = surface.fromPluginResponse(outcome.value, pc.response);
        model = pc.response?.model ?? model;
      } else if (outcome.kind === "error") {
        error = outcome.error;
        target = outcome.target ?? targetOf(outcome.error) ?? "unknown";
        pc.error = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        if (outcome.partial) {
          // Failed mid-stream: tokens were consumed, so after plugins (budget) run too.
          usage = outcome.partial.usage;
          usageEstimated = outcome.partial.usageEstimated === true;
          model = outcome.partial.response.model || model;
          this.exposeCost(pc, target, usage);
          pc.response = outcome.partial.response;
          await this.deps.plugins.runOnError(pc);
          await this.deps.plugins.runAfter(pc);
        } else {
          await this.deps.plugins.runOnError(pc);
        }
      } else if (outcome.kind === "rejected") {
        error = outcome.error;
      }
    } catch (err) {
      pluginError = err;
      error ??= err;
    } finally {
      settlePluginContext(pc);
    }

    const durationMs = Date.now() - run.startTime;
    const entry: RequestLogEntry = {
      timestamp: new Date().toISOString(),
      requestId: ctx?.traceId ?? "",
      model,
      provider: target,
      strategy: this.deps.strategyLabel,
      durationMs,
      surface: surface.logLabel,
    };
    if (usage)
      entry.tokens = { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens };
    if (usageEstimated) entry.usageEstimated = true;
    if (outcome.kind === "rejected" || outcome.kind === "short_circuit") {
      const rejection =
        outcome.kind === "rejected" && outcome.error instanceof PluginRejectionError ? outcome.error : undefined;
      entry.plugin = outcome.plugin;
      entry.outcome = outcome.kind === "rejected" ? "plugin_rejected" : "plugin_short_circuit";
      entry.status = outcome.kind === "rejected" ? (rejection?.status ?? toGatewayError(outcome.error).status) : 200;
      if (rejection) entry.error = rejection.reason;
      else if (outcome.kind === "rejected") entry.error = messageOf(outcome.error);
    } else if (error !== undefined) {
      entry.error = messageOf(error);
      entry.status = toGatewayError(error).status;
    } else {
      entry.status = 200;
    }
    this.log(entry);
    this.record(outcome, surface.logLabel, target, model, usage);
    const tracer = getTracer();
    if (error !== undefined && run.span !== undefined)
      tracer.recordError(run.span as never, error instanceof Error ? error : new Error(String(error)));
    if (run.span !== undefined) tracer.endSpan(run.span as never);

    if (pluginError !== undefined) throw pluginError;
    return value;
  }

  /** Request-log entry for a request that never went through begin() (pass-through before plugins). */
  log(entry: RequestLogEntry): void {
    void getRequestLogger().logRequest(entry);
    for (const sink of this.deps.logSinks()) {
      try {
        sink(entry);
      } catch (err) {
        console.error(`[request-log] sink failed: ${messageOf(err)}`);
      }
    }
  }

  /** Cost of this request at the serving target's rates, for after plugins (budget) and metrics. */
  private exposeCost(pc: InternalPluginContext, target: string, usage: Usage | undefined): void {
    pc.metadata["_target"] = target;
    const rates = this.deps.targetConfig(target);
    if (rates && usage) pc.metadata["_costUsd"] = costOf(rates, usage);
  }

  private record(
    outcome: FinalizeOutcome<unknown>,
    surfaceLabel: string,
    target: string,
    model: string,
    usage: Usage | undefined,
  ): void {
    const metrics = getMetrics();
    if (outcome.kind === "rejected" || outcome.kind === "short_circuit") {
      metrics.recordPluginBlocked(
        outcome.plugin,
        outcome.kind === "rejected" ? "plugin_rejected" : "plugin_short_circuit",
        surfaceLabel,
      );
      if (outcome.kind === "rejected" && outcome.plugin === "rate-limit")
        metrics.recordRateLimitRejection(NO_UPSTREAM_PROVIDER);
      return;
    }
    if (!usage) return;
    metrics.recordTokens(target, model, usage.promptTokens, usage.completionTokens);
    const cost = costOf(this.deps.targetConfig(target), usage);
    if (cost > 0) metrics.recordCost(target, model, cost);
  }
}

/** Sum usage helper re-exported for callers that accumulate (MCP loop, streams). */
export { addUsage };

function targetOf(err: unknown): string | undefined {
  const t = (err as { target?: unknown } | null)?.target;
  return typeof t === "string" && t !== "" ? t : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
