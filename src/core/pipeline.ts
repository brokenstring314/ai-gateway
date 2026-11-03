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
 *                callbacks → key meter (tokens toward quota / TPM) → request
 *                log (console + sinks, e.g. usage rollups) → metrics
 *                (tokens, plugin blocked) → span end
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
import { GUARDRAIL_METADATA_KEY, type GuardrailRecord } from "../plugins/builtins/pii-secret-guard/plugin.js";
import type { ChatCompletionRequest, IProvider, RequestContext, StreamChunk, Usage } from "../providers/types.js";
import { CircuitOpenError } from "../routing/circuit-breaker.js";
import { ConcurrencyLimitError } from "../routing/concurrency-limiter.js";
import type { IStrategy } from "../routing/types.js";
import { type ModelCatalog, type ModelRoute, modelAllowed } from "../routing/model-catalog.js";
import { invalidRequest, modelNotAllowed, modelNotFound, modelUnavailable, toGatewayError } from "./errors.js";
import { checkLimits, enforceChatPolicy } from "./model-policy.js";
import { strategyRunOptions, type TargetExecutor } from "./executor.js";
import type { McpLoop } from "./mcp-loop.js";
import { runChatStream, type ChatShapedSurface } from "./chat-stream.js";
import type { FinalizeOutcome, RequestRun, Result, Surface } from "./types.js";
import { addUsage, estimatePromptTokens, resolveUsage } from "./usage.js";
import type { KeyMeter, Reservation } from "../usage/key-meter.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../config/types.js";
import { KEY_RPM_METADATA } from "../plugins/builtins/rate-limit.js";

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
  /** Published models: the only names served, and the targets serving each (routing/model-catalog.ts). */
  readonly catalog: ModelCatalog;
  readonly aliases: Readonly<Record<string, string>>;
  readonly strategyLabel: string;
  readonly targetConfig: (name: string) => TargetConfig | undefined;
  readonly mcp: () => McpLoop | null;
  readonly logSinks: () => Iterable<RequestLogSink>;
  /** Per-key quota / RPM / TPM counters, shared by every snapshot (usage/key-meter.ts). */
  readonly keyMeter?: KeyMeter;
  /** TPM for keys without their own: the rate-limit plugin's maxTokensPerMinute. */
  readonly globalTpm?: number;
  /** limits.maxOutputTokens: output ceiling for models without published metadata.maxOutputTokens (RB6). */
  readonly maxOutputTokens?: number;
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
      // Metered usage of every upstream call (RB1): an upstream that reports
      // no or an implausible usage is estimated, round by round.
      let metered = meteredUsage(surface, request, value);
      let usage = metered.usage;
      let usageEstimated = metered.estimated;
      if (mcp) {
        const looped = await mcp.run(ctx, request as never, value as never, async (c, r) => {
          const next = await this.attempt(surface, r as unknown as Req, c);
          target = next.target;
          metered = meteredUsage(surface, r as unknown as Req, next.value);
          usage = addUsage(usage, metered.usage);
          usageEstimated ||= metered.estimated;
          return next.value as never;
        });
        value = looped.response as Res;
      }
      if (ctx) ctx.servedTarget = target;
      value = await this.finalize(run, { kind: "ok", value, target, usage, usageEstimated });
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
    return runChatStream(this, this.deps.executor, surface, req, ctx);
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
    // Which surface (chat, completions, embeddings, images, passthrough) and
    // whether it streams, for plugins that scope themselves (pii-secret-guard).
    pluginCtx.metadata["_surfaceName"] = surface.name;
    if (surface.logLabel.endsWith("_stream")) pluginCtx.metadata["_streaming"] = true;
    // A key with its own RPM is limited by the key meter, not the rate-limit plugin.
    if ((ctx?.client?.limits?.rpm ?? null) !== null) pluginCtx.metadata[KEY_RPM_METADATA] = true;
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
      this.checkModelAccess(surface, requestedModel, ctx);
      // Key limits (0.3.0 P5): in-memory counters only. An admitted request
      // always runs to the end; it holds a reservation (estimated prompt +
      // output cap, RB3) that finalize releases when its tokens are counted.
      const unmetered = surface.name === "passthrough" || surface.name === "images";
      run.reservation = this.deps.keyMeter?.admit(ctx?.client, {
        ...(this.deps.globalTpm !== undefined ? { globalTpm: this.deps.globalTpm } : {}),
        // Routes whose usage is not in tokens: a key with a token quota cannot be metered there.
        unmetered,
        reserve: () => (unmetered ? 0 : this.reservationFor(surface, resolved)),
      });
    } catch (err) {
      await this.finalize(run, { kind: "error", error: err });
      throw err;
    }

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
      run.request = this.applyModelPolicy(surface, run.request);
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

  /**
   * Tokens a request reserves in the key meter while it runs (RB3): the
   * estimated prompt plus its output cap — max_completion_tokens /
   * max_tokens, else the model's published maxOutputTokens, else
   * limits.maxOutputTokens — times n. Embeddings reserve the input only.
   */
  reservationFor<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req): number {
    const view = surface.toPluginView(req);
    const prompt = estimatePromptTokens(view);
    if (surface.name === "embeddings") return prompt;
    const meta = this.deps.catalog.lookup(surface.model(req))?.metadata;
    const cap =
      view.maxCompletionTokens ??
      view.maxTokens ??
      meta?.maxOutputTokens ??
      this.deps.maxOutputTokens ??
      DEFAULT_MAX_OUTPUT_TOKENS;
    const n = typeof view.n === "number" && Number.isFinite(view.n) && view.n > 1 ? Math.min(view.n, 128) : 1;
    return prompt + cap * n;
  }

  /**
   * Step 1b: the requested name must be a published model (or an alias of
   * one) that the caller's key may use. Restricted keys are checked first,
   * so they learn nothing about models outside their list.
   */
  checkModelAccess<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, requested: string, ctx: RequestContext): void {
    const allowed = ctx?.allowedModels;
    if (requested === "" && surface.name === "passthrough") {
      // A forwarded body without a model (e.g. /v1/audio/* multipart).
      if (allowed !== undefined) {
        throw modelNotAllowed(
          "This API key is restricted to specific models, and this request names no model. " +
            'Send a JSON body with a "model" field.',
        );
      }
      return;
    }
    const entry = this.deps.catalog.lookup(requested);
    if (!modelAllowed(allowed, requested, entry?.name ?? requested)) {
      throw modelNotAllowed(
        `This API key is not allowed to use the model "${requested}". GET /v1/models lists the models it can use.`,
      );
    }
    if (!entry) {
      throw modelNotFound(
        requested === ""
          ? "The request names no model. GET /v1/models lists the models you can use."
          : `The model "${requested}" does not exist on this gateway: it is not a published model or alias. ` +
              "GET /v1/models lists the models you can use.",
      );
    }
    if (!entry.enabled) {
      throw modelNotFound(`The model "${requested}" is currently disabled on this gateway.`);
    }
    if (!entry.available) throw unavailableModel(requested);
  }

  /**
   * Step 3b (0.3.0 P3): check the final request against the model's
   * metadata (400 with the reason when it cannot be served) and apply the
   * meaning-preserving rewrites. Chat gets the full policy; legacy
   * completions the output-limit and context checks.
   */
  applyModelPolicy<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req): Req {
    const model = surface.model(req);
    const entry = this.deps.catalog.lookup(model);
    if (!entry) return req;
    if (surface.name === "chat") {
      return enforceChatPolicy(
        req as unknown as ChatCompletionRequest,
        entry.metadata,
        model,
        this.deps.maxOutputTokens,
      ) as unknown as Req;
    }
    if (surface.name === "completions") {
      checkLimits(surface.toPluginView(req), entry.metadata, model, this.deps.maxOutputTokens);
    }
    return req;
  }

  /** The request as sent to one target: its upstream model name and binding params. */
  forTarget<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req, route: ModelRoute, target: string): Req {
    const renamed = surface.withModel(req, route.upstreamModel(target));
    const params = route.params(target);
    if (!params || surface.name !== "chat") return renamed;
    const chat = renamed as unknown as ChatCompletionRequest;
    return { ...chat, extra: { ...chat.extra, ...structuredClone(params) } } as unknown as Req;
  }

  /** How `model` (a published name, aliases already applied) is routed; throws 404 when it is not served. */
  route(model: string): ModelRoute {
    const entry = this.deps.catalog.lookup(model);
    if (!entry) {
      throw modelNotFound(
        `The model "${model}" does not exist on this gateway: it is not a published model or alias. ` +
          "GET /v1/models lists the models you can use.",
      );
    }
    if (!entry.enabled) throw modelNotFound(`The model "${model}" is currently disabled on this gateway.`);
    if (!entry.available) throw unavailableModel(model);
    return entry.route;
  }

  /** Step 4: ordered candidate targets for a request: only targets bound to its model. */
  candidates<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req, route?: ModelRoute): readonly string[] {
    const model = surface.model(req);
    const r = route ?? this.route(model);
    if (surface.candidates === "strategy") return r.strategy.selectTargets(surface.toPluginView(req));
    const ordered = [...new Set(r.strategy.selectTargets({ model, messages: [] }))].filter(
      (name) => this.deps.lookup(name) !== undefined,
    );
    const capable = ordered.filter((name) => surface.supports(this.deps.lookup(name)!));
    if (capable.length > 0) return capable;
    throw invalidRequest(
      `The model "${model}" does not support ${surface.unsupportedLabel ?? surface.name}`,
      "unsupported_capability",
    );
  }

  /** Step 5: one upstream call over the candidates (breaker, limiter, retry, failover). */
  async attempt<Req, Res, Chunk>(
    surface: Surface<Req, Res, Chunk>,
    req: Req,
    ctx: RequestContext,
  ): Promise<{ value: Res; target: string }> {
    const route = this.route(surface.model(req));
    const candidates = this.candidates(surface, req, route);
    let target = candidates[0] ?? "unknown";
    const onServed = (name: string) => {
      target = name;
    };
    const opts =
      surface.candidates === "strategy"
        ? strategyRunOptions(route.strategy, false, candidates.length, onServed)
        : { label: `Gateway(${surface.logLabel})`, supports: (p: IProvider) => surface.supports(p), onServed };
    try {
      // Each binding may name the model differently upstream.
      const value = await this.deps.executor.run(
        ctx,
        candidates,
        (p) => surface.call(p, ctx, this.forTarget(surface, req, route, p.name)),
        opts,
      );
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
        pc.metadata["_target"] = target;
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
          // Failed mid-stream: tokens were consumed, so after plugins run too.
          usage = outcome.partial.usage;
          usageEstimated = outcome.partial.usageEstimated === true;
          model = outcome.partial.response.model || model;
          pc.metadata["_target"] = target;
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
      try {
        settlePluginContext(pc);
      } finally {
        // Release the key meter reservation and count the tokens (toward the
        // quota and TPM window), whatever happened above: exactly once (RB3).
        this.deps.keyMeter?.settle(
          ctx?.client,
          run.reservation as Reservation | undefined,
          usage ? quotaTokensOf(usage) : 0,
        );
      }
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
    if (ctx?.client?.id) entry.keyId = ctx.client.id;
    entry.publishedModel = surface.model(run.request);
    if (usage) {
      entry.tokens = { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens };
      const cacheHit = cacheHitTokens(usage);
      if (cacheHit > 0) entry.tokens.cacheHit = cacheHit;
      const reasoning = usage.completionTokensDetails?.["reasoning_tokens"];
      if (typeof reasoning === "number" && reasoning > 0) entry.tokens.reasoning = reasoning;
    }
    if (usageEstimated) entry.usageEstimated = true;
    // Guardrail detections: plugin, direction, action and entity TYPES only (never values).
    const guardrail = pc.metadata[GUARDRAIL_METADATA_KEY];
    if (Array.isArray(guardrail) && guardrail.length > 0) entry.guardrail = guardrail as GuardrailRecord[];
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
      // An after-request plugin rejected the response (pii-secret-guard response scanning).
      if (pluginError instanceof PluginRejectionError && pluginError.plugin) {
        entry.plugin = pluginError.plugin;
        getMetrics().recordPluginBlocked(pluginError.plugin, "response_rejected", surface.logLabel);
      }
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
  }
}

/** Prompt tokens served from the upstream's cache (OpenAI cached_tokens, DeepSeek prompt_cache_hit_tokens). */
export function cacheHitTokens(usage: Usage): number {
  const cached = usage.promptTokensDetails?.["cached_tokens"];
  if (typeof cached === "number" && cached > 0) return cached;
  const hit = usage.extra?.["prompt_cache_hit_tokens"];
  return typeof hit === "number" && Number.isFinite(hit) && hit > 0 ? hit : 0;
}

/** Tokens a request counts toward a key's quota / TPM: total, or prompt + completion when larger. */
export function quotaTokensOf(usage: Usage): number {
  const sum = nonNegativeNumber(usage.promptTokens) + nonNegativeNumber(usage.completionTokens);
  return Math.max(nonNegativeNumber(usage.totalTokens), sum);
}

function nonNegativeNumber(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The usage one upstream result is metered with: reported, or estimated when missing / implausible. */
function meteredUsage<Req, Res, Chunk>(
  surface: Surface<Req, Res, Chunk>,
  req: Req,
  res: Res,
): { usage: Usage | undefined; estimated: boolean } {
  const reported = surface.usage(res);
  const estimate = surface.estimateUsage;
  if (!estimate) return { usage: reported, estimated: false };
  return resolveUsage(reported, () => estimate(req, res));
}

function unavailableModel(model: string) {
  return modelUnavailable(
    `The model "${model}" is published but has no available channel right now ` +
      "(every binding is disabled, drained or bound to a disabled channel).",
  );
}

/** Sum usage helper re-exported for callers that accumulate (MCP loop, streams). */
export { addUsage };

function targetOf(err: unknown): string | undefined {
  const t = (err as { target?: unknown } | null)?.target;
  if (typeof t === "string" && t !== "") return t;
  // ProviderError / FallbackExhaustedError: the same target the
  // X-Gateway-Target header reports.
  const mapped = toGatewayError(err).target;
  return mapped !== undefined && mapped !== "" ? mapped : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
