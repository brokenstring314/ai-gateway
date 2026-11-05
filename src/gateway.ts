/**
 * Gateway — the embedded API facade.
 *
 * Assembly lives in core/assembly.ts and every request runs through the
 * pipeline (core/pipeline.ts: execute / executeStream). This class owns the
 * assembled parts, the MCP registry and the request-log sinks, and keeps
 * the documented embedded methods (route, routeStream, embed, …) as thin
 * wrappers over the pipeline.
 */

import { assembleGateway, breakerStates, type GatewayParts, stableKey } from "./core/assembly.js";
import type { ModelCatalog } from "./routing/model-catalog.js";
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
import { TargetLoad } from "./routing/balancer.js";
import type { PublicHostGuard } from "./security/url-guard.js";
import { type KeyEvent, type KeyPool, KeyStateRegistry } from "./routing/key-pool.js";
import type { ConcurrencyLimiterRegistry } from "./routing/concurrency-limiter.js";
import { KeyMeter } from "./usage/key-meter.js";

/**
 * One immutable generation of the gateway's runtime: the config and every
 * part assembled from it. A request reads the current snapshot once when it
 * starts and uses it to the end (a stream included), so a reload never
 * changes a request in flight.
 */
export interface RuntimeSnapshot {
  /** 1 for the constructor's config, +1 per successful reload. */
  readonly version: number;
  readonly config: GatewayConfig;
  readonly parts: GatewayParts;
  readonly createdAt: Date;
}

/** Thrown by Gateway.reload when the new config changes a startup-only section. */
export class ReloadRejectedError extends Error {
  override name = "ReloadRejectedError";
}

export class Gateway {
  /** The current runtime generation; replaced whole by reload(). */
  private snapshot: RuntimeSnapshot;
  private mcpRegistry: McpRegistry;
  private readonly mcpExecutor: McpExecutor | null;
  /** MCP is startup-only: the config its connections were made from. */
  private readonly mcpConfigKey: string;
  /** Request-log sinks (e.g. the SQLite log store behind /admin/logs). */
  private readonly logSinks = new Set<RequestLogSink>();
  /** Providers and plugins added at runtime; re-applied to every new snapshot. */
  private readonly extraProviders = new Map<string, IProvider>();
  private readonly extraPlugins: Array<{ stage: Stage; plugin: IPlugin }> = [];
  /** Called after each successful reload. */
  private readonly reloadListeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  /** Upstream key health (cooldowns, auto-disabled keys), kept across reloads. */
  private readonly keyStates = new KeyStateRegistry();
  /** Requests in flight per target (least_inflight balancing), kept across reloads. */
  private readonly targetLoad = new TargetLoad();
  /** Per-key token quota / RPM / TPM counters, kept across reloads (usage/key-meter.ts). */
  private readonly meter: KeyMeter;

  /**
   * `options.publicHostGuard`: request-time SSRF guard for channels with
   * publicNetworkOnly (default: the shared guard with system DNS; tests
   * inject a resolver).
   */
  constructor(
    config: GatewayConfig,
    private readonly options: { readonly publicHostGuard?: PublicHostGuard; readonly keyMeter?: KeyMeter } = {},
  ) {
    this.meter = options.keyMeter ?? new KeyMeter();
    this.snapshot = { version: 1, config, parts: this.assemble(config), createdAt: new Date() };
    this.mcpRegistry = new McpRegistry();
    this.mcpExecutor = createMcpExecutor(config, this.mcpRegistry);
    this.mcpConfigKey = stableKey(config.mcpServers ?? null);
  }

  /** The request-time SSRF guard injected at construction (tests), else undefined (the shared default applies). */
  publicHostGuard(): PublicHostGuard | undefined {
    return this.options.publicHostGuard;
  }

  private assemble(config: GatewayConfig, previous?: GatewayParts): GatewayParts {
    const parts = assembleGateway(
      config,
      {
        mcpExecutor: () => this.mcpExecutor,
        logSinks: () => this.logSinks,
        keyState: this.keyStates,
        load: this.targetLoad,
        keyMeter: this.meter,
        ...(this.options.publicHostGuard ? { guard: this.options.publicHostGuard } : {}),
      },
      previous,
    );
    for (const provider of this.extraProviders.values()) parts.registry.register(provider);
    for (const { stage, plugin } of this.extraPlugins) parts.plugins.register(stage, plugin);
    return parts;
  }

  // ── Live configuration ──

  /**
   * Swap in a new config without a restart. The new runtime is assembled
   * first; if that throws (invalid config) the current one keeps serving and
   * the error propagates. On success the swap is a single reference
   * assignment: requests already running finish on the old snapshot, new ones
   * use the new. Circuit breakers, concurrency limiters and plugins whose
   * config is unchanged keep their state (see CarryState).
   *
   * Startup-only sections cannot change here: `mcpServers` (connections are
   * made at startup) throws ReloadRejectedError. Server, auth and other
   * process settings are read by the HTTP layer at startup and are not
   * affected by a reload.
   */
  reload(config: GatewayConfig): RuntimeSnapshot {
    if (stableKey(config.mcpServers ?? null) !== this.mcpConfigKey) {
      throw new ReloadRejectedError("mcpServers cannot change at runtime; restart the gateway to apply MCP changes");
    }
    const current = this.snapshot;
    const parts = this.assemble(config, current.parts);
    const next: RuntimeSnapshot = { version: current.version + 1, config, parts, createdAt: new Date() };
    this.snapshot = next;
    // Keys no longer configured lose their state (requests on the old snapshot keep their own references).
    this.keyStates.retain(parts.keyStateIds);
    for (const listener of this.reloadListeners) {
      try {
        listener(next);
      } catch (err) {
        console.error("[gateway] reload listener failed:", err);
      }
    }
    return next;
  }

  /**
   * Upstream key events (a key cooled down after a 429, or was disabled
   * after a 401/402). Listeners must be quick; the config store persists
   * disables asynchronously from here.
   */
  onKeyEvent(listener: (event: KeyEvent) => void): () => void {
    return this.keyStates.onEvent(listener);
  }

  /** Forget the runtime state of a key (an operator re-enabled it). */
  resetKeyState(channel: string, keyId: string): void {
    this.keyStates.reset(channel, keyId);
  }

  /** Runtime state of a channel's keys (cooldown / auto-disabled), by key id. */
  keyRuntimeState(channel: string): ReadonlyArray<{ id: string; cooldownUntil?: string; disabled?: unknown }> {
    const provider = this.snapshot.parts.registry.get(channel) as { keyPool?: KeyPool } | undefined;
    return provider?.keyPool?.snapshot() ?? [];
  }

  /** Per-key quota / RPM / TPM counters (the same object for the gateway's whole life). */
  keyMeter(): KeyMeter {
    return this.meter;
  }

  /** The current runtime generation (version, config, parts). */
  currentSnapshot(): RuntimeSnapshot {
    return this.snapshot;
  }

  /** Call `listener` after every successful reload; returns an unsubscribe function. */
  onReload(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  private get pipeline(): Pipeline {
    return this.snapshot.parts.pipeline;
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
    const { config, parts } = this.snapshot;
    const model = config.aliases?.[req.model] ?? req.model;
    return (await parts.pipeline.attempt(embeddingsSurface, { ...req, model }, ctx)).value;
  }

  /** Image generation request without plugins (see embed()). */
  async generateImage(ctx: RequestContext, req: ImageRequest): Promise<ImageResponse> {
    const { config, parts } = this.snapshot;
    const model = config.aliases?.[req.model] ?? req.model;
    return (await parts.pipeline.attempt(imagesSurface, { ...req, model }, ctx)).value;
  }

  // ── MCP ──

  async initMcp(): Promise<void> {
    await connectMcpServers(this.snapshot.config, this.mcpRegistry);
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
    return Object.values(breakerStates(this.snapshot.parts.circuitBreakers)).includes("OPEN");
  }

  /** Current state of every configured circuit breaker, by target name. */
  circuitBreakerStates(): Readonly<Record<string, string>> {
    return breakerStates(this.snapshot.parts.circuitBreakers);
  }

  /**
   * Whether at least one registered target is not behind an OPEN breaker,
   * i.e. the strategy still has somewhere to send traffic. Informational:
   * /readyz reports it but does not fail on it (see handlers/health.ts).
   */
  hasUsableTarget(): boolean {
    const { registry, circuitBreakers } = this.snapshot.parts;
    return registry.list().some((name) => circuitBreakers.get(name)?.getState() !== "OPEN");
  }

  // ── Registry, plugins, accessors ──

  /** List all models from all providers. */
  listModels(): readonly ModelInfo[] {
    return this.snapshot.parts.catalog.list().map((e) => ({ id: e.name, ownedBy: e.targets[0] ?? "gateway" }));
  }

  /** Published models of the current snapshot (routing/model-catalog.ts). */
  modelCatalog(): ModelCatalog {
    return this.snapshot.parts.catalog;
  }

  /** Add a provider to the registry at runtime (kept across reloads). */
  registerProvider(provider: IProvider): void {
    this.extraProviders.set(provider.name, provider);
    this.snapshot.parts.registry.register(provider);
  }

  /** Add a plugin at a specific stage (kept across reloads). */
  registerPlugin(stage: Stage, plugin: IPlugin): void {
    this.extraPlugins.push({ stage, plugin });
    this.snapshot.parts.plugins.register(stage, plugin);
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
    return this.snapshot.config;
  }

  /** The current request pipeline (execute / begin / finalize). */
  getPipeline(): Pipeline {
    return this.snapshot.parts.pipeline;
  }

  /** Get the provider registry (read-only view). */
  getRegistry(): Readonly<ProviderRegistry> {
    return this.snapshot.parts.registry;
  }

  /** Get the circuit breaker registry. */
  getCircuitBreakerRegistry(): CircuitBreakerRegistry {
    return this.snapshot.parts.circuitBreakers;
  }

  /** Get the per-target concurrency limiter registry. */
  getConcurrencyLimiterRegistry(): ConcurrencyLimiterRegistry {
    return this.snapshot.parts.concurrencyLimiters;
  }
}
