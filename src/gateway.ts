/**
 * Gateway core — routes requests through providers, strategies, and plugins.
 *
 * The central orchestrator that wires together:
 *   ProviderRegistry → IStrategy → PluginManager
 *
 * route()  — non-streaming request flow
 * routeStream() — streaming request flow with fallback
 */

import { applyPassthroughMaxTokens, passthroughMaxTokens, passthroughTokenField } from "./core/surfaces/passthrough.js";
import type {
  IProvider,
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageRequest,
  ImageResponse,
  ModelInfo,
} from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createProviderFromTarget } from "./core/provider-presets.js";
import type { IStrategy, StrategyMode } from "./routing/types.js";
import { createStrategy } from "./routing/strategy-factory.js";
import { resolveStrategyMode } from "./config/removed.js";
import { assertConfigReferences } from "./config/validate.js";
import type { StrategyConfig as RoutingStrategyConfig } from "./routing/strategy-factory.js";
import { PluginManager } from "./plugins/manager.js";
import { PluginRejectionError } from "./plugins/error.js";
import type { IPlugin, Stage } from "./plugins/types.js";
import { buildPluginsFromConfig } from "./plugins/builtins/from-config.js";
import type { GatewayConfig, RetryConfig, TargetConfig } from "./config/types.js";
import { getMetrics } from "./metrics/metrics.js";
import { McpRegistry } from "./mcp/registry.js";
import { McpExecutor } from "./mcp/executor.js";
import { CircuitBreakerRegistry, CircuitOpenError, type CircuitBreaker } from "./routing/circuit-breaker.js";
import { TargetExecutor, chatStreamPlan } from "./core/executor.js";
import { executeStream, iterateStream } from "./core/stream-runner.js";
import { ConcurrencyLimiterRegistry, ConcurrencyLimitError } from "./routing/concurrency-limiter.js";
import { Pipeline, type RequestLogSink } from "./core/pipeline.js";
import { mcpLoop } from "./core/mcp-loop.js";
import { chatSurface } from "./core/surfaces/chat.js";
import { embeddingsSurface } from "./core/surfaces/embeddings.js";
import { imagesSurface } from "./core/surfaces/images.js";
import type { StreamEnd, Surface } from "./core/types.js";
import { settlePluginContext } from "./plugins/context.js";
import {
  accumulateChunk,
  estimateStreamUsage,
  newStreamAccumulator,
} from "./core/usage.js";
import { toGatewayError } from "./core/errors.js";

type McpServerRuntimeConfig = GatewayConfig["mcpServers"] extends readonly (infer T)[]
  ? T & {
      allowedTools?: string[];
      maxCallDepth?: number;
      timeoutSeconds?: number;
      required?: boolean;
    }
  : {
      allowedTools?: string[];
      maxCallDepth?: number;
      timeoutSeconds?: number;
      required?: boolean;
    };

// ── Config → Strategy config bridge ──

function buildStrategyConfig(config: GatewayConfig): {
  mode: StrategyMode;
  config: RoutingStrategyConfig;
} {
  const sc = config.strategy;
  const targetNames = config.targets.map((t) => t.name);

  const mode = resolveStrategyMode(sc.mode);
  switch (mode) {
    case "single": {
      const target = sc.targets?.[0] ?? targetNames[0];
      if (!target) throw new Error("single strategy requires at least one target");
      return { mode: "single", config: { target } };
    }
    case "fallback": {
      const fallbackTargets = sc.targets ?? targetNames;
      return { mode: "fallback", config: { targets: fallbackTargets } };
    }
    case "loadbalance": {
      // Weight 0 drains a target: it gets no traffic (not even as failover).
      const targets = (sc.targets ?? targetNames).map((name) => {
        const t = config.targets.find((tgt) => tgt.name === name);
        return { name, weight: t?.weight ?? sc.weights?.[name] ?? 1 };
      });
      return { mode: "loadbalance", config: { targets } };
    }
    case "conditional": {
      return {
        mode: "conditional",
        config: {
          rules: sc.rules ?? [],
          defaultTarget: sc.targets?.[0] ?? targetNames[0],
        },
      };
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown strategy mode: ${String(_exhaustive)}`);
    }
  }
}

// ── Gateway class ──

export class Gateway {
  private registry: ProviderRegistry;
  private strategy: IStrategy;
  private pluginManager: PluginManager;
  private aliases: Record<string, string>;
  private config: GatewayConfig;
  private mcpRegistry: McpRegistry;
  private mcpExecutor: McpExecutor | null;
  private circuitBreakers: CircuitBreakerRegistry;
  private concurrencyLimiters: ConcurrencyLimiterRegistry;
  /** Runs strategy-ordered candidates: breaker, limiter, retry, failover (core/executor.ts). */
  private readonly executor: TargetExecutor;
  /** The request pipeline (core/pipeline.ts): plugins, executor, MCP loop, finalize. */
  private readonly pipeline: Pipeline;
  /** Request-log sinks (e.g. the SQLite log store behind /admin/logs). */
  private readonly logSinks = new Set<RequestLogSink>();

  constructor(config: GatewayConfig) {
    // Embedded configs skip the schema: same cross-reference checks as validate/startup.
    assertConfigReferences(config);
    this.config = config;
    this.aliases = config.aliases ?? {};
    this.registry = new ProviderRegistry();
    this.pluginManager = new PluginManager();
    for (const { stage, plugin } of buildPluginsFromConfig(config.plugins)) {
      this.pluginManager.register(stage, plugin);
    }
    this.mcpRegistry = new McpRegistry();
    this.mcpExecutor = null;
    this.circuitBreakers = new CircuitBreakerRegistry();
    this.concurrencyLimiters = new ConcurrencyLimiterRegistry();

    for (const target of config.targets) {
      const provider = createProviderFromTarget(target, config.compatibility?.onUnsupportedParam);
      this.registry.register(provider);
      if (target.circuitBreaker) {
        this.circuitBreakers.getOrCreate(target.name, target.circuitBreaker);
      }
      this.ensureConcurrencyLimiter(target);
    }

    const { mode, config: strategyConfig } = buildStrategyConfig(config);
    this.strategy = createStrategy(mode, strategyConfig);
    // Per-target retry, honored for every strategy (a target without one gets a single attempt).
    const retryConfigs = new Map<string, RetryConfig>();
    for (const t of config.targets) {
      if (t.retry) retryConfigs.set(t.name, t.retry);
    }
    const metrics = getMetrics();
    for (const [name, breaker] of this.circuitBreakers.all()) metrics.setCircuitBreakerState(name, breaker.getState());
    this.executor = new TargetExecutor({
      lookup: (name) => this.registry.get(name),
      breaker: (name) => this.circuitBreakers.get(name),
      limiter: (name) => this.concurrencyLimiters.get(name),
      retryConfig: (name) => retryConfigs.get(name),
      onAttemptFailure: (name, err) => metrics.recordProviderError(name, toGatewayError(err).kind),
      onBreakerSettled: (name, breaker: CircuitBreaker) => metrics.setCircuitBreakerState(name, breaker.getState()),
    });

    if (config.mcpServers && config.mcpServers.length > 0) {
      const firstServer = config.mcpServers[0] as McpServerRuntimeConfig;
      this.mcpExecutor = new McpExecutor(this.mcpRegistry, firstServer.maxCallDepth);
    }

    const targets = new Map(config.targets.map((t) => [t.name, t]));
    this.pipeline = new Pipeline({
      plugins: this.pluginManager,
      strategy: this.strategy,
      executor: this.executor,
      lookup: (name) => this.registry.get(name),
      findByModel: (model) => this.registry.findByModel(model),
      aliases: this.aliases,
      strategyLabel: config.strategy.mode,
      targetConfig: (name) => targets.get(name),
      mcp: () => (this.mcpExecutor ? mcpLoop(this.mcpExecutor) : null),
      logSinks: () => this.logSinks,
    });
  }

  /** Send every request-log entry to `sink` as well as the console logger (idempotent per sink). */
  addRequestLogSink(sink: RequestLogSink): void {
    this.logSinks.add(sink);
  }

  /** The request pipeline (execute / begin / finalize), for handlers and the stream runner. */
  getPipeline(): Pipeline {
    return this.pipeline;
  }

  private ensureConcurrencyLimiter(target: TargetConfig): void {
    if (!target.concurrency?.maxConcurrency) return;
    this.concurrencyLimiters.getOrCreate(target.name, {
      maxConcurrency: target.concurrency.maxConcurrency,
      queueSize: target.concurrency.queueSize,
    });
  }

  async initMcp(): Promise<void> {
    if (!this.config.mcpServers || this.config.mcpServers.length === 0) return;
    // Connect all servers concurrently: each handshake is bounded by its own
    // timeout, and one slow or failing server must not delay the others.
    await Promise.all(
      this.config.mcpServers.map(async (serverConfig) => {
        try {
          const runtime = serverConfig as McpServerRuntimeConfig;
          await this.mcpRegistry.addServer(serverConfig, {
            allowedTools: runtime.allowedTools,
            maxCallDepth: runtime.maxCallDepth,
            timeoutSeconds: runtime.timeoutSeconds,
            required: runtime.required,
          });
        } catch (err) {
          console.error(`[gateway] MCP server "${serverConfig.name}" failed to connect: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    this.mcpReadiness();
  }

  /**
   * Liveness: false once a required MCP server has failed its reconnect
   * attempts too many times in a row (see McpRestartPolicy), so the
   * orchestrator restarts the process.
   */
  isMcpLive(): boolean {
    return this.mcpRegistry.requiredServersLive();
  }

  /** Whether every configured required MCP server completed initialization. */
  isMcpReady(): boolean {
    return this.mcpRegistry.requiredServersReady();
  }

  /** Current readiness state for each configured MCP server. */
  mcpReadiness(): Readonly<Record<string, string>> {
    const states: Record<string, string> = {};
    const metrics = getMetrics();
    for (const name of this.mcpRegistry.serverNames()) {
      states[name] = this.mcpRegistry.readiness(name);
      metrics.setMcpServerUp(name, states[name] === "ready");
    }
    return states;
  }

  /** Whether any configured circuit breaker is currently open. */
  hasOpenCircuitBreaker(): boolean {
    for (const breaker of this.circuitBreakers.all().values()) {
      if (breaker.getState() === "OPEN") return true;
    }
    return false;
  }

  /** Current state of every configured circuit breaker, by target name. */
  circuitBreakerStates(): Readonly<Record<string, string>> {
    const states: Record<string, string> = {};
    for (const [name, breaker] of this.circuitBreakers.all()) {
      states[name] = breaker.getState();
    }
    return states;
  }

  /**
   * Whether at least one registered target is not behind an OPEN breaker,
   * i.e. the strategy still has somewhere to send traffic. Informational:
   * /readyz reports it but does not fail on it (see handlers/health.ts).
   */
  hasUsableTarget(): boolean {
    for (const name of this.registry.list()) {
      if (this.circuitBreakers.get(name)?.getState() !== "OPEN") return true;
    }
    return false;
  }

  // ── Public API ──

  /** Non-streaming chat completion: a wrapper over execute(chat). */
  async route(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return (await this.pipeline.execute(chatSurface, req, ctx)).value;
  }

  /**
   * Streaming chat completion. Before plugins, candidates and the single
   * finalize come from the pipeline; the after-request plugins, the request
   * log and the metrics see the streamed request exactly once, however it
   * ends: normal completion, upstream error, or the client going away
   * (generator return()). Without a usage chunk, usage is estimated
   * (~4 chars/token) so the budget cannot be bypassed.
   */
  async *routeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncGenerator<StreamChunk> {
    const begun = await this.pipeline.begin(chatStreamSurface, req, ctx);
    // chatStreamSurface never accepts a short-circuit (begin() rejects it).
    if (begun.kind !== "proceed") return;
    const { run } = begun;
    // MCP tools are NOT injected on the streaming path: there is no agentic
    // loop here, so injected tools would surface to the client as tool_calls
    // for tools it never declared and cannot execute.
    const finalReq = run.request;
    const acc = newStreamAccumulator(finalReq.model);
    // Breaker, limiter, retry and failover before the first chunk:
    // core/executor.ts; first chunk, StreamEnd and settle-once:
    // core/stream-runner.ts; finalize-once: core/pipeline.ts.
    const finalize = async (end: StreamEnd, target: string | undefined): Promise<void> => {
      const streamError = streamErrorOf(end, acc.chunks);
      const usage = acc.usage ?? estimateStreamUsage(finalReq, acc);
      const usageEstimated = acc.usage === undefined;
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
        await this.pipeline.finalize(run, { kind: "ok", value: response, target: target ?? "unknown", usage, usageEstimated });
      } else if (acc.chunks === 0) {
        await this.pipeline.finalize(run, { kind: "error", error: streamError, target });
      } else {
        await this.pipeline.finalize(run, { kind: "error", error: streamError, target, partial: { response, usage, usageEstimated } });
      }
    };
    let result: Awaited<ReturnType<typeof executeStream<StreamChunk>>>;
    try {
      const plan = chatStreamPlan(this.executor, this.strategy, ctx, finalReq);
      result = await executeStream(ctx, plan, { mapError: toPipelineError, finalize });
    } catch (err) {
      // e.g. strategy selection failed before executeStream could settle.
      await this.pipeline.finalize(run, { kind: "error", error: err });
      throw err;
    }
    for await (const chunk of iterateStream(result, ctx?.signal, toPipelineError)) {
      accumulateChunk(acc, chunk);
      yield chunk;
    }
  }

  /** Embedding request through the pipeline (plugins, executor, finalize). */
  async embedWithPlugins(
    ctx: RequestContext,
    req: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    return (await this.pipeline.execute(embeddingsSurface, req, ctx)).value;
  }

  /** Image generation request through the pipeline (plugins, executor, finalize). */
  async generateImageWithPlugins(
    ctx: RequestContext,
    req: ImageRequest,
  ): Promise<ImageResponse> {
    return (await this.pipeline.execute(imagesSurface, req, ctx)).value;
  }

  /**
   * Run the before-request plugins for a pass-through proxy request whose
   * body shape is unknown. Text is taken from top-level `messages`, `input`
   * (string, string[] or Responses-style items) or `prompt`; bodies that are
   * not JSON still go through key-scoped plugins (rate-limit, budget check)
   * with no messages. Throws PluginRejectionError to block the request.
   * Because an arbitrary body cannot be rewritten faithfully, a plugin that
   * modifies the message content (e.g. word-filter redact) or short-circuits
   * causes a rejection instead of forwarding the original text.
   * The body's output token limit (`max_output_tokens` / `max_tokens` /
   * `max_completion_tokens`) is the plugin view's `maxTokens`; when a plugin
   * caps it (max-token) the rewritten body text is returned and must be
   * forwarded instead of the original (S3-6). Otherwise returns undefined.
   */
  async runPassthroughBeforePlugins(ctx: RequestContext, bodyText: string | undefined, path = ""): Promise<string | undefined> {
    let body: unknown;
    try {
      body = bodyText !== undefined && bodyText !== "" ? JSON.parse(bodyText) : undefined;
    } catch {
      body = undefined;
    }
    const obj = body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const isJsonObject = body !== null && typeof body === "object" && !Array.isArray(body);
    const tokenField = isJsonObject ? passthroughTokenField(path, obj) : undefined;
    const maxTokens = passthroughMaxTokens(obj, tokenField);
    const request: ChatCompletionRequest = {
      model: typeof obj["model"] === "string" ? obj["model"] : "",
      messages: extractPassthroughMessages(obj),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
    const begun = await this.pipeline.begin(passthroughSurface, request, ctx);
    // Forwarded by the proxy: nothing more to account here, but release
    // whatever the before plugins reserved (budget).
    settlePluginContext(begun.run.pluginCtx);
    const view = begun.run.pluginCtx.request;
    return applyPassthroughMaxTokens(obj, tokenField, view.maxTokens ?? view.maxCompletionTokens);
  }

  /**
   * Embedding request without plugins (embedded API), routed through the
   * strategy's capable candidates with breaker, limiter, retry and failover.
   */
  async embed(
    ctx: RequestContext,
    req: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    const model = this.aliases[req.model] ?? req.model;
    return (await this.pipeline.attempt(embeddingsSurface, { ...req, model }, ctx)).value;
  }

  /** Image generation request without plugins (see embed()). */
  async generateImage(
    ctx: RequestContext,
    req: ImageRequest,
  ): Promise<ImageResponse> {
    const model = this.aliases[req.model] ?? req.model;
    return (await this.pipeline.attempt(imagesSurface, { ...req, model }, ctx)).value;
  }

  /** List all models from all providers. */
  listModels(): readonly ModelInfo[] {
    return this.registry.allModels();
  }

  /** Add a provider to the registry at runtime. */
  registerProvider(provider: IProvider): void {
    this.registry.register(provider);
  }

  /** Add a plugin at a specific stage. */
  registerPlugin(stage: Stage, plugin: IPlugin): void {
    this.pluginManager.register(stage, plugin);
  }

  close(): void {
    this.mcpRegistry.closeAll();
  }

  /** Get the current config. */
  getConfig(): Readonly<GatewayConfig> {
    return this.config;
  }

  /** Get the provider registry (read-only view). */
  getRegistry(): Readonly<ProviderRegistry> {
    return this.registry;
  }

  /** Get the circuit breaker registry. */
  getCircuitBreakerRegistry(): CircuitBreakerRegistry {
    return this.circuitBreakers;
  }

  /** Get the per-target concurrency limiter registry. */
  getConcurrencyLimiterRegistry(): ConcurrencyLimiterRegistry {
    return this.concurrencyLimiters;
  }

}

/** Streaming chat: same as chat, but a plugin short-circuit is rejected. */
const chatStreamSurface: Surface<ChatCompletionRequest, ChatCompletionResponse, StreamChunk> = {
  ...chatSurface,
  logLabel: "chat_stream",
  fromShortCircuit: () => undefined,
  shortCircuitUnsupported: "Plugin short-circuited during streaming request; short-circuit is not supported for streaming",
};

/**
 * Pass-through proxy routes: an arbitrary body cannot be rewritten
 * faithfully, so a plugin that modifies the message content (e.g.
 * word-filter redact) or short-circuits causes a rejection instead of
 * forwarding the original text.
 */
const passthroughSurface: Surface<ChatCompletionRequest, never> = {
  name: "passthrough",
  capability: "raw",
  logLabel: "passthrough",
  pluginSurfaceTag: "passthrough",
  candidates: "strategy",
  model: (req) => req.model,
  withModel: (req, model) => (model === req.model ? req : { ...req, model }),
  toPluginView: (req) => req,
  applyPluginView: (req, view) => {
    if (JSON.stringify(view.messages) !== JSON.stringify(req.messages)) {
      throw new PluginRejectionError(
        "before_request",
        "Request content was modified by a plugin; pass-through proxy routes cannot forward modified content",
        undefined,
      );
    }
    return req;
  },
  supports: () => false,
  call: () => Promise.reject(new Error("pass-through requests are forwarded by the proxy")),
  usage: () => undefined,
  toPluginResponse: () => undefined,
  fromShortCircuit: () => undefined,
  shortCircuitUnsupported: "Plugin short-circuit is not supported on pass-through proxy routes",
};

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

type PassthroughMessage = ChatCompletionRequest["messages"][number];

/** Best-effort text extraction from an unknown OpenAI-style request body. */
function extractPassthroughMessages(body: Record<string, unknown>): PassthroughMessage[] {
  const out: PassthroughMessage[] = [];
  const pushText = (text: unknown, role: unknown = "user") => {
    const t = textOf(text);
    if (t !== undefined) out.push({ role: (typeof role === "string" ? role : "user") as PassthroughMessage["role"], content: t });
  };
  const fromItems = (items: unknown) => {
    if (typeof items === "string") return pushText(items);
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item === "string") pushText(item);
      else if (item !== null && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        pushText(rec["content"] ?? rec["text"], rec["role"]);
      }
    }
  };
  fromItems(body["messages"]);
  fromItems(body["input"]);
  fromItems(body["prompt"]);
  pushText(body["instructions"], "system");
  return out;
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map((p) => {
      if (typeof p === "string") return p;
      if (p !== null && typeof p === "object") {
        const t = (p as Record<string, unknown>)["text"];
        return typeof t === "string" ? t : "";
      }
      return "";
    }).filter((t) => t !== "");
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}
