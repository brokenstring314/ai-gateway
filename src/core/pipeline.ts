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

import type { ModelMetadata, TargetConfig } from "../config/types.js";
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
import {
  GatewayError,
  invalidRequest,
  modelNotAllowed,
  modelNotFound,
  modelUnavailable,
  toGatewayError,
} from "./errors.js";
import { checkLimits, enforceChatPolicy, outputCapOf, reasoningBudgetOf } from "./model-policy.js";
import { checkPassthroughOutputLimit, type PassthroughRequest } from "./surfaces/passthrough.js";
import { boundLogEntry, loggableModelName, MAX_N, modelNameProblem, nProblem } from "./request-limits.js";
import { strategyRunOptions, type TargetExecutor } from "./executor.js";
import type { McpLoop } from "./mcp-loop.js";
import { runChatStream, type ChatShapedSurface } from "./chat-stream.js";
import type { FinalizeOutcome, RequestRun, Result, Surface } from "./types.js";
import { addUsage, estimatePromptTokens, resolveUsage } from "./usage.js";
import type { KeyMeter, Reservation, ReservationPlan, ReservationRoom } from "../usage/key-meter.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../config/types.js";
import { KEY_RPM_METADATA } from "../plugins/builtins/rate-limit.js";

/**
 * Output tokens per second charged for a non-streaming upstream call that was
 * cut off (client disconnect / gateway timeout) before it answered (review
 * 2026-11-05 F2 / D4): deliberately slow — real upstreams generate several
 * times faster — so the estimate stays an under- rather than an over-charge,
 * and never above the request's output cap.
 */
export const ABORTED_CALL_OUTPUT_TOKENS_PER_SECOND = 10;

/** Provider label for requests that never reached an upstream target. */
export const NO_UPSTREAM_PROVIDER = "none";

/** Usage-row model of a failed request whose model is not published (D3). */
export const UNKNOWN_MODEL = "(unknown)";

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
  /** TTL of an unsettled key-meter reservation: the request lifetime bound (usage/key-meter.ts reservationTtlMs). */
  readonly reservationTtlMs?: number;
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
    // Clients see the published model name, never a binding's upstream name (B3).
    const published = surface.model(begun.run.request);
    if (begun.kind === "answered")
      return { kind: "ok", value: withPublishedModel(begun.value, published), target: NO_UPSTREAM_PROVIDER };
    const { run } = begun;
    let target: string | undefined;
    // Metered usage of every completed upstream call (RB1), kept outside the
    // try so a request that fails later (a later MCP round errors, the loop
    // exceeds its depth, the client goes away) still counts the rounds that
    // were served (review 2026-11-05 F3).
    let usage: Usage | undefined;
    let usageEstimated = false;
    // The request of the upstream call in flight (the current MCP round).
    let inFlight: Req = run.request;
    try {
      let request = run.request;
      // Chat-capable surfaces (chat, completions) run the MCP agentic loop.
      const mcp = surface.capability === "chat" ? this.deps.mcp() : null;
      if (mcp) request = mcp.inject(request as never) as Req;
      inFlight = request;
      const first = await this.attempt(surface, request, ctx);
      target = first.target;
      let value = first.value;
      // An upstream that reports no or an implausible usage is estimated, round by round.
      let metered = meteredUsage(surface, request, value);
      usage = metered.usage;
      usageEstimated = metered.estimated;
      if (mcp) {
        const looped = await mcp.run(ctx, request as never, value as never, async (c, r) => {
          inFlight = r as unknown as Req;
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
      return { kind: "ok", value: withPublishedModel(value, published), target, usage };
    } catch (err) {
      // Completed rounds (F3) plus an estimate for a call the upstream
      // received before the request was aborted (F2 / D4).
      const aborted = this.abortedCallUsage(surface, inFlight, ctx);
      const failedUsage = addUsage(usage, aborted);
      await this.finalize(run, {
        kind: "error",
        error: err,
        target,
        ...(failedUsage
          ? { metered: { usage: failedUsage, usageEstimated: usageEstimated || aborted !== undefined } }
          : {}),
      });
      throw err;
    }
  }

  /**
   * Estimated usage of an upstream call that was sent but cut off by the
   * request's abort before any output reached the gateway — client
   * disconnect or the gateway's request timeout (review 2026-11-05 F2 / D4;
   * set by the executor: RequestContext.abortedUpstreamCall). The upstream
   * has the request and normally bills at least its prompt, so the key is
   * never charged 0:
   *  - always the estimated prompt;
   *  - non-streaming: plus ABORTED_CALL_OUTPUT_TOKENS_PER_SECOND for every
   *    second the call ran, never more than the request's output cap (a
   *    slow, conservative generation rate; the output itself is unknown);
   *  - streaming (no chunk yet): prompt only — no token had been produced.
   * Undefined when no such call happened, or on surfaces that are not
   * token-metered (images, pass-through).
   */
  abortedCallUsage<Req, Res, Chunk>(
    surface: Surface<Req, Res, Chunk>,
    req: Req,
    ctx: RequestContext,
  ): Usage | undefined {
    const call = ctx?.abortedUpstreamCall;
    if (!call || !surface.estimateUsage) return undefined;
    const view = surface.toPluginView(req);
    const promptTokens = estimatePromptTokens(view);
    let completionTokens = 0;
    if (!call.streaming && surface.name !== "embeddings") {
      const seconds = Math.max(0, call.abortedAt - call.sentAt) / 1000;
      const byTime = Math.floor(seconds * ABORTED_CALL_OUTPUT_TOKENS_PER_SECOND);
      completionTokens = Math.min(byTime, this.outputCap(surface, req));
    }
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  /** A request's output cap times n: requested, else the model's / gateway's limit (RB3 / RB6). */
  private outputCap<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req): number {
    const o = this.outputLimits(surface, req);
    const perChoice = Math.max(o.explicit?.value ?? o.fallback, o.budget?.value ?? 0);
    return perChoice * o.n;
  }

  /**
   * What bounds a request's output (RB3 / RB6 / FQ-1): the larger of
   * max_tokens / max_completion_tokens (F1: both are forwarded), the largest
   * reasoning budget field (thinking.budget_tokens, reasoning.max_tokens …,
   * including what the model's reasoning map turns reasoning_effort into),
   * the default when the client set no limit (the model's published
   * maxOutputTokens, else limits.maxOutputTokens) and n (≤ MAX_N).
   */
  private outputLimits<Req, Res, Chunk>(
    surface: Surface<Req, Res, Chunk>,
    req: Req,
  ): {
    readonly explicit: { readonly value: number; readonly param: string } | undefined;
    readonly budget: { readonly value: number; readonly param: string } | undefined;
    readonly fallback: number;
    readonly n: number;
    readonly meta: ModelMetadata | undefined;
  } {
    const view = surface.toPluginView(req);
    const meta = this.deps.catalog.lookup(surface.model(req))?.metadata;
    const fallback = meta?.maxOutputTokens ?? this.deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const n =
      typeof view.n === "number" && Number.isFinite(view.n) && view.n > 1 ? Math.min(Math.floor(view.n), MAX_N) : 1;
    return {
      explicit: outputCapOf(view),
      budget: reasoningBudgetOf(extraAfterReasoningMap(view, meta)),
      fallback,
      n,
      meta,
    };
  }

  /**
   * Tokens a request reserves in the key meter while it runs (RB3, FQ-1 /
   * FQ-2): the estimated prompt (non-text parts at conservative rates) plus
   * its output ceiling times n. The ceiling is the client's max_tokens /
   * max_completion_tokens or reasoning budget, whichever is larger — never
   * lowered: a reservation larger than `room` is refused by the key meter.
   * When the client set no output limit, the default (the model's
   * maxOutputTokens, else limits.maxOutputTokens) is fitted into `room` (the
   * quota left, the TPM) and that value is later sent upstream as max_tokens
   * (begin → withReservedOutputCap). Embeddings reserve the input only.
   */
  reservationPlan<Req, Res, Chunk>(
    surface: Surface<Req, Res, Chunk>,
    req: Req,
    room: ReservationRoom = {},
  ): ReservationPlan & { readonly perChoice: number } {
    const prompt = estimatePromptTokens(surface.toPluginView(req));
    if (surface.name === "embeddings") {
      return { tokens: prompt, perChoice: 0, param: "input", describe: `about ${prompt} input tokens` };
    }
    const o = this.outputLimits(surface, req);
    let perChoice: number;
    let param: string;
    let what: string;
    if (o.explicit !== undefined) {
      // Above the model's / gateway's limit the request is refused by the
      // model policy (or a plugin lowers it first), so it never needs more.
      perChoice = Math.min(o.explicit.value, o.fallback);
      param = o.explicit.param;
      what = `${param} ${perChoice}`;
    } else {
      perChoice = o.fallback;
      param = "max_tokens";
      what = `the default output limit ${perChoice} (max_tokens not set)`;
      const bounds = [room.quotaLeft, room.tpm].filter((b): b is number => b !== undefined && Number.isFinite(b));
      if (bounds.length > 0) {
        const fit = Math.floor((Math.min(...bounds) - prompt) / o.n);
        if (fit < perChoice) {
          perChoice = Math.max(1, fit);
          param = o.n > 1 ? "n" : "messages";
          what = `at least ${perChoice} output token${perChoice === 1 ? "" : "s"}`;
        }
      }
    }
    if (o.budget !== undefined && Math.min(o.budget.value, o.fallback) > perChoice) {
      perChoice = Math.min(o.budget.value, o.fallback);
      param = o.budget.param;
      what = `${param} ${perChoice}`;
    }
    const describe = `about ${prompt} input tokens + ${what}${o.n > 1 ? ` × n ${o.n}` : ""}`;
    return { tokens: prompt + perChoice * o.n, perChoice, param, describe };
  }

  /**
   * For a request the key meter refused as larger than the quota left / the
   * TPM (FQ-2): the model policy's output-limit error (max_tokens_exceeded,
   * conflicting_max_tokens, context_length_exceeded) when the request also
   * breaks one, else undefined.
   */
  private limitErrorInstead<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req, err: unknown): unknown {
    const code = err instanceof GatewayError ? err.code : null;
    if (code !== "request_exceeds_quota" && code !== "request_exceeds_tpm") return undefined;
    if (surface.name !== "chat" && surface.name !== "completions") return undefined;
    const model = surface.model(req);
    try {
      checkLimits(
        surface.toPluginView(req),
        this.deps.catalog.lookup(model)?.metadata,
        model,
        this.deps.maxOutputTokens,
      );
    } catch (limit) {
      return limit;
    }
    return undefined;
  }

  /** Total tokens a request reserves with no quota / TPM room to fit into (tests, diagnostics). */
  reservationFor<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req): number {
    return this.reservationPlan(surface, req).tokens;
  }

  /**
   * A chat / completions request without max_tokens / max_completion_tokens
   * is sent upstream with an explicit max_tokens (FQ-2), so the upstream's
   * own default (often "the rest of the context") cannot exceed what the
   * gateway reserved and checked:
   *  - the key has a quota or TPM: the per-choice ceiling the key meter
   *    reserved (run.reservedOutputCap);
   *  - otherwise, when the model publishes maxOutputTokens: that value.
   * Never more than the context window minus the estimated prompt. A value
   * the client set is never touched. Official OpenAI targets get it as
   * max_completion_tokens instead (forTarget): OpenAI's reasoning models
   * refuse max_tokens.
   */
  withReservedOutputCap<Req, Res, Chunk>(
    surface: Surface<Req, Res, Chunk>,
    req: Req,
    run: RequestRun<Req, Res, Chunk>,
  ): Req {
    if (surface.name !== "chat" && surface.name !== "completions") return req;
    const chat = req as unknown as ChatCompletionRequest;
    const set = outputCapOf(chat);
    const reserved = run.reservedOutputCap;
    if (set !== undefined) {
      // A client's value is never above what was reserved (the reservation is
      // its value, and an over-limit value was refused above); a larger one can
      // only be a before-request plugin's default: held to the reservation.
      if (reserved === undefined || set.value <= reserved) return req;
      return {
        ...chat,
        ...(chat.maxTokens !== undefined ? { maxTokens: reserved } : {}),
        ...(chat.maxCompletionTokens !== undefined ? { maxCompletionTokens: reserved } : {}),
      } as unknown as Req;
    }
    const meta = this.deps.catalog.lookup(surface.model(req))?.metadata;
    let cap = reserved ?? meta?.maxOutputTokens;
    if (cap === undefined || !Number.isFinite(cap) || cap < 1) return req;
    if (meta?.contextWindow !== undefined) {
      const room = meta.contextWindow - estimatePromptTokens(chat);
      if (room >= 1 && room < cap) cap = room;
    }
    const out: ChatCompletionRequest & { [INJECTED_OUTPUT_CAP]?: true } = {
      ...chat,
      maxTokens: Math.floor(cap),
      [INJECTED_OUTPUT_CAP]: true,
    };
    return out as unknown as Req;
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
    // D3 (red team 2026-11-05): an over-long / control-character model name is
    // a 400. It is answered after the key meter (so it still counts toward the
    // key's RPM) but never travels further: from here on the request carries
    // the name cut to its loggable size (spans, logs, usage rows).
    const rawModel = surface.model(req);
    const badModelName = modelNameProblem(rawModel);
    const requestedModel = badModelName ? loggableModelName(rawModel) : rawModel;
    if (badModelName) req = surface.withModel(req, requestedModel);
    const resolved = badModelName ? req : surface.withModel(req, this.deps.aliases[requestedModel] ?? requestedModel);
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
      // Key limits (0.3.0 P5): in-memory counters only. An admitted request
      // always runs to the end; it holds a reservation (estimated prompt +
      // output cap, RB3) that finalize releases when its tokens are counted.
      const unmetered = surface.name === "passthrough" || surface.name === "images";
      // n above MAX_N (FQ-2) is refused before anything is reserved.
      const tooManyChoices = badModelName ? undefined : nProblem(surface.toPluginView(resolved).n);
      if (tooManyChoices) throw tooManyChoices;
      run.reservation = this.deps.keyMeter?.admit(ctx?.client, {
        ...(this.deps.globalTpm !== undefined ? { globalTpm: this.deps.globalTpm } : {}),
        ...(this.deps.reservationTtlMs !== undefined ? { reservationTtlMs: this.deps.reservationTtlMs } : {}),
        // Routes whose usage is not in tokens: a key with a token quota cannot be metered there.
        unmetered,
        reserve: (room) => {
          if (unmetered) return 0;
          const plan = this.reservationPlan(surface, resolved, room);
          if (plan.perChoice > 0) run.reservedOutputCap = plan.perChoice;
          return plan;
        },
      });
      // Model checks after the key meter (D3): a request naming an unknown,
      // forbidden or malformed model still counts toward the key's RPM.
      if (badModelName) throw badModelName;
      this.checkModelAccess(surface, requestedModel, ctx);
    } catch (caught) {
      // A request too large for the key that is also over the model's output
      // limit gets the model's 400 (max_tokens_exceeded …): the more basic problem.
      const err = this.limitErrorInstead(surface, resolved, caught) ?? caught;
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
      run.request = this.withReservedOutputCap(surface, run.request, run);
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
    if (surface.name === "passthrough") {
      checkPassthroughOutputLimit(req as PassthroughRequest, entry.metadata, model, this.deps.maxOutputTokens);
    }
    return req;
  }

  /** The request as sent to one target: its upstream model name and binding params. */
  forTarget<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req, route: ModelRoute, target: string): Req {
    let renamed = surface.withModel(req, route.upstreamModel(target));
    // The gateway's own max_tokens (withReservedOutputCap) goes to official
    // OpenAI as max_completion_tokens: its reasoning models refuse max_tokens.
    const injected = renamed as unknown as ChatCompletionRequest & { [INJECTED_OUTPUT_CAP]?: true };
    if (injected[INJECTED_OUTPUT_CAP] === true && isOfficialOpenAI(this.deps.targetConfig(target))) {
      const { maxTokens, ...rest } = injected;
      renamed = { ...rest, maxCompletionTokens: maxTokens } as unknown as Req;
    }
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
    // The published model (aliases resolved) for successes and failures alike (B3);
    // what the upstream called it is kept apart, in upstreamModel.
    const model = surface.model(run.request);
    let upstreamModel: string | undefined;
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
        upstreamModel =
          reportedModel(view?.model) ?? reportedModel(outcome.value) ?? this.boundUpstreamModel(model, target);
        pc.response = view && usage && view.usage !== usage ? { ...view, usage } : view;
        await this.deps.plugins.runAfter(pc);
        if (surface.fromPluginResponse && pc.response) value = surface.fromPluginResponse(outcome.value, pc.response);
      } else if (outcome.kind === "error") {
        error = outcome.error;
        target = outcome.target ?? targetOf(outcome.error) ?? "unknown";
        pc.error = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        if (outcome.metered) {
          // No answer, but upstream calls were made (F2 / F3): their tokens count.
          usage = outcome.metered.usage;
          usageEstimated = outcome.metered.usageEstimated === true;
        }
        if (outcome.partial) {
          // Failed mid-stream: tokens were consumed, so after plugins run too.
          usage = outcome.partial.usage;
          usageEstimated = outcome.partial.usageEstimated === true;
          upstreamModel = reportedModel(outcome.partial.response.model);
          pc.metadata["_target"] = target;
          pc.response = outcome.partial.response;
          await this.deps.plugins.runOnError(pc);
          await this.deps.plugins.runAfter(pc);
        } else {
          await this.deps.plugins.runOnError(pc);
        }
        upstreamModel ??= this.boundUpstreamModel(model, target);
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
    if (upstreamModel !== undefined) entry.upstreamModel = upstreamModel;
    if (ctx?.client?.id) entry.keyId = ctx.client.id;
    entry.publishedModel = model;
    // A failed request naming no published model is counted under one usage
    // bucket, not one row per made-up name (D3); request_logs keep the name.
    if (error !== undefined && entry.publishedModel !== "" && !this.deps.catalog.lookup(entry.publishedModel))
      entry.publishedModel = UNKNOWN_MODEL;
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

  /**
   * The upstream model name `target` is sent for `published` (its binding's
   * name), from the in-memory catalog; undefined when the target is not one
   * of the model's bindings (no upstream reached, unknown model).
   */
  private boundUpstreamModel(published: string, target: string): string | undefined {
    if (target === NO_UPSTREAM_PROVIDER || target === "unknown" || target === "") return undefined;
    const entry = this.deps.catalog.lookup(published);
    if (!entry || !entry.targets.includes(target)) return undefined;
    return entry.route.upstreamModel(target);
  }

  /** Request-log entry for a request that never went through begin() (pass-through before plugins). */
  log(raw: RequestLogEntry): void {
    // Every string a caller or upstream shaped is cut to its log size (D3).
    const entry = boundLogEntry(raw);
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

/** A non-empty model name reported by an upstream: a string, or the `model` field of a result object. */
function reportedModel(v: unknown): string | undefined {
  const m =
    typeof v === "string" ? v : v !== null && typeof v === "object" ? (v as { model?: unknown }).model : undefined;
  return typeof m === "string" && m !== "" ? m : undefined;
}

/**
 * `value` with its top-level `model` set to the published name (B3): a
 * response (chat, completions, embeddings) answers with the name the client
 * can call, never a binding's upstream model id. Values without a string
 * `model` field (images) are returned unchanged.
 */
export function withPublishedModel<T>(value: T, published: string): T {
  if (published === "" || value === null || typeof value !== "object") return value;
  const current = (value as { model?: unknown }).model;
  if (typeof current !== "string" || current === published) return value;
  return { ...value, model: published };
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

/** Marks a request whose max_tokens the gateway set itself (withReservedOutputCap), not the client. */
const INJECTED_OUTPUT_CAP: unique symbol = Symbol("gateway.injectedOutputCap");

/** A target that is the official OpenAI API (provider openai, default or api.openai.com base URL). */
function isOfficialOpenAI(cfg: TargetConfig | undefined): boolean {
  if (!cfg || cfg.provider !== "openai") return false;
  if (cfg.baseURL === undefined || cfg.baseURL === "") return true;
  try {
    return new URL(cfg.baseURL).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * The request's extras as the upstream will see them after the model's
 * reasoning map (model-policy enforceChatPolicy) turned reasoning_effort into
 * provider parameters, so a mapped thinking budget is reserved as well.
 */
function extraAfterReasoningMap(
  view: Pick<ChatCompletionRequest, "extra">,
  meta: ModelMetadata | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const extra = view.extra;
  const effort = extra?.["reasoning_effort"];
  const reasoning = meta?.reasoning;
  if (effort === undefined || reasoning === null || typeof reasoning !== "object") return extra;
  const mapped = reasoning.map?.[String(effort)];
  return mapped && typeof mapped === "object" ? { ...extra, ...(mapped as Record<string, unknown>) } : extra;
}
