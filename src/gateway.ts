/**
 * Gateway — the embedded API facade.
 *
 * Assembly lives in core/assembly.ts and every request runs through the
 * pipeline (core/pipeline.ts: execute / executeStream). This class owns the
 * assembled parts, the MCP registry and the request-log sinks, and keeps
 * the documented embedded methods (route, routeStream, embed, …) as thin
 * wrappers over the pipeline.
 */

import { assembleGateway, breakerStates } from "./core/assembly.js";
import type { ChatShapedSurface } from "./core/chat-stream.js";
import { connectMcpServers, createMcpExecutor, mcpReadiness } from "./core/mcp-runtime.js";
import type { Pipeline, RequestLogSink } from "./core/pipeline.js";
import { chatSurface } from "./core/surfaces/chat.js";
import { embeddingsSurface } from "./core/surfaces/embeddings.js";
import { imagesSurface } from "./core/surfaces/images.js";
import { runPassthroughBefore } from "./core/surfaces/passthrough.js";
import type { Result, Surface } from "./core/types.js";
import type { GatewayConfig } from "./config/types.js";
import type { McpExecutor } from "./mcp/executor.js";
import { McpRegistry } from "./mcp/registry.js";
import type { PluginManager } from "./plugins/manager.js";
import type { IPlugin, Stage } from "./plugins/types.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageRequest,
  ImageResponse,
  IProvider,
  ModelInfo,
  RequestContext,
  StreamChunk,
} from "./providers/types.js";
import type { CircuitBreakerRegistry } from "./routing/circuit-breaker.js";
import type { ConcurrencyLimiterRegistry } from "./routing/concurrency-limiter.js";

export class Gateway {
  private readonly config: GatewayConfig;
  private readonly registry: ProviderRegistry;
  private readonly pluginManager: PluginManager;
  private mcpRegistry: McpRegistry;
  private readonly mcpExecutor: McpExecutor | null;
  private readonly circuitBreakers: CircuitBreakerRegistry;
  private readonly concurrencyLimiters: ConcurrencyLimiterRegistry;
  private readonly pipeline: Pipeline;
  /** Request-log sinks (e.g. the SQLite log store behind /admin/logs). */
  private readonly logSinks = new Set<RequestLogSink>();

  constructor(config: GatewayConfig) {
    this.config = config;
    const parts = assembleGateway(config, {
      mcpExecutor: () => this.mcpExecutor,
      logSinks: () => this.logSinks,
    });
    this.registry = parts.registry;
    this.pluginManager = parts.plugins;
    this.circuitBreakers = parts.circuitBreakers;
    this.concurrencyLimiters = parts.concurrencyLimiters;
    this.pipeline = parts.pipeline;
    this.mcpRegistry = new McpRegistry();
    this.mcpExecutor = createMcpExecutor(config, this.mcpRegistry);
  }

  // ── Requests ──

  /** Non-streaming chat completion: a wrapper over execute(chat). */
  async route(ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
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
  executeStream(
    surface: ChatShapedSurface,
    req: ChatCompletionRequest,
    ctx: RequestContext,
  ): AsyncGenerator<StreamChunk> {
    return this.pipeline.executeStream(surface, req, ctx);
  }

  /** Embedding request through the pipeline (plugins, executor, finalize). */
  async embedWithPlugins(ctx: RequestContext, req: EmbeddingRequest): Promise<EmbeddingResponse> {
    return (await this.pipeline.execute(embeddingsSurface, req, ctx)).value;
  }

  /** Image generation request through the pipeline (plugins, executor, finalize). */
  async generateImageWithPlugins(ctx: RequestContext, req: ImageRequest): Promise<ImageResponse> {
    return (await this.pipeline.execute(imagesSurface, req, ctx)).value;
  }

  /**
   * Before-request plugins for a pass-through proxy request (body shape
   * unknown). Throws PluginRejectionError to block it; returns the rewritten
   * body text when a plugin capped its token limit (S3-6), else undefined.
   * See core/surfaces/passthrough.ts.
   */
  async runPassthroughBeforePlugins(
    ctx: RequestContext,
    bodyText: string | undefined,
    path = "",
  ): Promise<string | undefined> {
    return runPassthroughBefore(this.pipeline, ctx, bodyText, path);
  }

  /**
   * Embedding request without plugins (embedded API), routed through the
   * strategy's capable candidates with breaker, limiter, retry and failover.
   */
  async embed(ctx: RequestContext, req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = this.config.aliases?.[req.model] ?? req.model;
    return (await this.pipeline.attempt(embeddingsSurface, { ...req, model }, ctx)).value;
  }

  /** Image generation request without plugins (see embed()). */
  async generateImage(ctx: RequestContext, req: ImageRequest): Promise<ImageResponse> {
    const model = this.config.aliases?.[req.model] ?? req.model;
    return (await this.pipeline.attempt(imagesSurface, { ...req, model }, ctx)).value;
  }

  // ── MCP ──

  async initMcp(): Promise<void> {
    await connectMcpServers(this.config, this.mcpRegistry);
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
    return mcpReadiness(this.mcpRegistry);
  }

  // ── Health ──

  /** Whether any configured circuit breaker is currently open. */
  hasOpenCircuitBreaker(): boolean {
    return Object.values(breakerStates(this.circuitBreakers)).includes("OPEN");
  }

  /** Current state of every configured circuit breaker, by target name. */
  circuitBreakerStates(): Readonly<Record<string, string>> {
    return breakerStates(this.circuitBreakers);
  }

  /**
   * Whether at least one registered target is not behind an OPEN breaker,
   * i.e. the strategy still has somewhere to send traffic. Informational:
   * /readyz reports it but does not fail on it (see handlers/health.ts).
   */
  hasUsableTarget(): boolean {
    return this.registry.list().some((name) => this.circuitBreakers.get(name)?.getState() !== "OPEN");
  }

  // ── Registry, plugins, accessors ──

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

  /** Send every request-log entry to `sink` as well as the console logger (idempotent per sink). */
  addRequestLogSink(sink: RequestLogSink): void {
    this.logSinks.add(sink);
  }

  close(): void {
    this.mcpRegistry.closeAll();
  }

  /** Get the current config. */
  getConfig(): Readonly<GatewayConfig> {
    return this.config;
  }

  /** The request pipeline (execute / begin / finalize). */
  getPipeline(): Pipeline {
    return this.pipeline;
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
