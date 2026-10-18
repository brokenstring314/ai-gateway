/**
 * Gateway core — routes requests through providers, strategies, and plugins.
 *
 * The central orchestrator that wires together:
 *   ProviderRegistry → IStrategy → PluginManager
 *
 * route()  — non-streaming request flow
 * routeStream() — streaming request flow with fallback
 */

import { runPassthroughBefore } from "./core/surfaces/passthrough.js";
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
import type { IPlugin, Stage } from "./plugins/types.js";
import { buildPluginsFromConfig } from "./plugins/builtins/from-config.js";
import type { GatewayConfig, RetryConfig, TargetConfig } from "./config/types.js";
import { getMetrics } from "./metrics/metrics.js";
import { McpRegistry } from "./mcp/registry.js";
import { McpExecutor } from "./mcp/executor.js";
import { CircuitBreakerRegistry, type CircuitBreaker } from "./routing/circuit-breaker.js";
import { TargetExecutor } from "./core/executor.js";
import type { ChatShapedSurface } from "./core/chat-stream.js";
import { ConcurrencyLimiterRegistry } from "./routing/concurrency-limiter.js";
import { Pipeline, type RequestLogSink } from "./core/pipeline.js";
import { mcpLoop } from "./core/mcp-loop.js";
import { chatSurface } from "./core/surfaces/chat.js";
import { embeddingsSurface } from "./core/surfaces/embeddings.js";
import { imagesSurface } from "./core/surfaces/images.js";
import type { Result, Surface } from "./core/types.js";
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
    for (const { stage, plugin } of buildPluginsFromConfig(config.plugins, config.targets)) {
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
   * Streaming chat completion: a wrapper over executeStream(chat). The
   * after-request plugins, request log and metrics see the stream exactly
   * once, however it ends (core/chat-stream.ts).
   */
  routeStream(ctx: RequestContext, req: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    return this.pipeline.executeStream(chatSurface, req, ctx);
  }

  /** Any surface through the whole pipeline (plugins, executor, MCP loop, finalize). */
  execute<Req, Res, Chunk>(surface: Surface<Req, Res, Chunk>, req: Req, ctx: RequestContext): Promise<Result<Res>> {
    return this.pipeline.execute(surface, req, ctx);
  }

  /** A chat-shaped surface (chat, completions) streamed through the pipeline. */
  executeStream(surface: ChatShapedSurface, req: ChatCompletionRequest, ctx: RequestContext): AsyncGenerator<StreamChunk> {
    return this.pipeline.executeStream(surface, req, ctx);
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
    return runPassthroughBefore(this.pipeline, ctx, bodyText, path);
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
