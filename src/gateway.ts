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
  IEmbeddingProvider,
  IImageProvider,
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageRequest,
  ImageResponse,
  ModelInfo,
  Usage,
} from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { invalidRequest, modelNotFound, toGatewayError } from "./core/errors.js";
import { createProviderFromTarget } from "./core/provider-presets.js";
import type { IStrategy, StrategyMode } from "./routing/types.js";
import { createStrategy } from "./routing/strategy-factory.js";
import { resolveStrategyMode } from "./config/removed.js";
import { assertConfigReferences } from "./config/validate.js";
import type { StrategyConfig as RoutingStrategyConfig } from "./routing/strategy-factory.js";
import { PluginManager } from "./plugins/manager.js";
import { createPluginContext } from "./plugins/context.js";
import { PluginRejectionError } from "./plugins/error.js";
import type { IPlugin, Stage } from "./plugins/types.js";
import { buildPluginsFromConfig } from "./plugins/builtins/from-config.js";
import type { GatewayConfig, RetryConfig, TargetConfig } from "./config/types.js";
import { getMetrics } from "./metrics/metrics.js";
import { getTracer } from "./observability/otel-tracer.js";
import { getRequestLogger } from "./observability/request-log.js";
import { McpRegistry } from "./mcp/registry.js";
import { McpExecutor } from "./mcp/executor.js";
import { CircuitBreakerRegistry, CircuitOpenError } from "./routing/circuit-breaker.js";
import { TargetExecutor, chatStreamPlan, executeChat } from "./core/executor.js";
import { executeStream, iterateStream } from "./core/stream-runner.js";
import type { StreamEnd } from "./core/types.js";
import {
  ConcurrencyLimiterRegistry,
  ConcurrencyLimitError,
} from "./routing/concurrency-limiter.js";

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
  /** Target that produced each in-flight stream (first chunk), for stream logs / metrics. */

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
    this.executor = new TargetExecutor({
      lookup: (name) => this.registry.get(name),
      breaker: (name) => this.circuitBreakers.get(name),
      limiter: (name) => this.concurrencyLimiters.get(name),
      retryConfig: (name) => retryConfigs.get(name),
    });

    if (config.mcpServers && config.mcpServers.length > 0) {
      const firstServer = config.mcpServers[0] as McpServerRuntimeConfig;
      this.mcpExecutor = new McpExecutor(this.mcpRegistry, firstServer.maxCallDepth);
    }
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
    for (const name of this.mcpRegistry.serverNames()) {
      states[name] = this.mcpRegistry.readiness(name);
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

  async route(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const tracer = getTracer();
    const metrics = getMetrics();
    const logger = getRequestLogger();
    const span = tracer.startSpan("gateway.route", { "request.model": req.model });

    const startTime = Date.now();

    const resolved = this.resolveAlias(req);

    const pluginCtx = createPluginContext(resolved, ctx);
    try {
      await this.pluginManager.runBefore(pluginCtx);
    } catch (err) {
      tracer.endSpan(span);
      if (err instanceof PluginRejectionError) {
        this.recordPluginBlocked(ctx, req.model, "chat", startTime, err);
      }
      throw err;
    }

    if (pluginCtx._shortCircuited && pluginCtx.response) {
      tracer.endSpan(span);
      this.recordPluginBlocked(ctx, req.model, "chat", startTime, pluginCtx);
      return pluginCtx.response;
    }

    let finalReq = pluginCtx.request;

    if (this.mcpExecutor) {
      finalReq = this.mcpExecutor.injectTools(finalReq);
    }

    let response: ChatCompletionResponse;
    try {
      response = await this.executeWithCircuitBreaker(ctx, finalReq);
    } catch (err) {
      pluginCtx.error = err instanceof Error ? err : new Error(String(err));
      await this.pluginManager.runOnError(pluginCtx);
      tracer.recordError(span, pluginCtx.error);
      tracer.endSpan(span);

      const durationMs = Date.now() - startTime;
      void logger.logRequest({
        timestamp: new Date().toISOString(),
        requestId: ctx.traceId ?? "",
        model: req.model,
        provider: "unknown",
        strategy: this.config.strategy.mode,
        durationMs,
        error: pluginCtx.error.message,
      });

      throw err;
    }

    if (this.mcpExecutor && response.choices[0]?.message?.toolCalls && response.choices[0].message.toolCalls.length > 0) {
      response = await this.mcpExecutor.executeAgenticLoop(ctx, finalReq, response, (c, r) => this.executeWithCircuitBreaker(c, r));
    }

    pluginCtx.response = response;
    await this.pluginManager.runAfter(pluginCtx);
    response = pluginCtx.response ?? response;

    tracer.endSpan(span);

    const durationMs = Date.now() - startTime;
    const provider = response.provider;
    if (response.usage) {
      metrics.recordTokens(provider, response.model, response.usage.promptTokens, response.usage.completionTokens);
    }

    void logger.logRequest({
      timestamp: new Date().toISOString(),
      requestId: ctx.traceId ?? "",
      model: response.model,
      provider,
      strategy: this.config.strategy.mode,
      durationMs,
      tokens: response.usage ? {
        prompt: response.usage.promptTokens,
        completion: response.usage.completionTokens,
        total: response.usage.totalTokens,
      } : undefined,
    });

    return response;
  }

  async *routeStream(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): AsyncGenerator<StreamChunk> {
    const tracer = getTracer();
    const span = tracer.startSpan("gateway.routeStream", { "request.model": req.model });
    const beforeStart = Date.now();

    const resolved = this.resolveAlias(req);

    const pluginCtx = createPluginContext(resolved, ctx);
    try {
      await this.pluginManager.runBefore(pluginCtx);
    } catch (err) {
      tracer.endSpan(span);
      if (err instanceof PluginRejectionError) {
        this.recordPluginBlocked(ctx, req.model, "chat_stream", beforeStart, err);
      }
      throw err;
    }

    if (pluginCtx._shortCircuited) {
      tracer.endSpan(span);
      const rejection = new PluginRejectionError(
        "before_request",
        "Plugin short-circuited during streaming request; short-circuit is not supported for streaming",
        pluginCtx._shortCircuitedBy,
      );
      this.recordPluginBlocked(ctx, req.model, "chat_stream", beforeStart, rejection);
      throw rejection;
    }

    // MCP tools are NOT injected on the streaming path: there is no agentic
    // loop here, so injected tools would surface to the client as tool_calls
    // for tools it never declared and cannot execute. Use a non-streaming
    // request to let the gateway run MCP tools.
    const finalReq = pluginCtx.request;

    // Accumulate what the stream delivered so the after-request plugins
    // (budget, logger, ...), the request log and the metrics see the
    // streamed request exactly once, however it ends: normal completion,
    // upstream error, or the client going away (generator return()).
    const startTime = Date.now();
    const acc: StreamAccumulator = {
      id: "",
      created: Math.floor(startTime / 1000),
      model: finalReq.model,
      content: "",
      toolArgChars: 0,
      finishReason: "",
      usage: undefined,
      chunks: 0,
    };
    // Breaker, limiter, retry and failover before the first chunk:
    // core/executor.ts; first chunk, StreamEnd and finalize-once:
    // core/stream-runner.ts.
    const mapError = (err: unknown): unknown => this.translateConcurrencyError(err);
    const result = await executeStream(ctx, chatStreamPlan(this.executor, this.strategy, ctx, finalReq), {
      mapError,
      finalize: async (end, target) => {
        tracer.endSpan(span);
        await this.finalizeStream(ctx, req, finalReq, pluginCtx, acc, streamErrorOf(end, acc.chunks), startTime, target);
      },
    });
    for await (const chunk of iterateStream(result, ctx?.signal, mapError)) {
      accumulateChunk(acc, chunk);
      yield chunk;
    }
  }

  /**
   * Run the after-request (or on-error) plugins, the request log and the
   * metrics for a finished stream. When the upstream sent no usage chunk the
   * token counts are estimated (~4 chars/token) so the budget cannot be
   * bypassed by omitting stream_options.include_usage.
   */
  private async finalizeStream(
    ctx: RequestContext,
    originalReq: ChatCompletionRequest,
    finalReq: ChatCompletionRequest,
    pluginCtx: ReturnType<typeof createPluginContext>,
    acc: StreamAccumulator,
    streamError: Error | undefined,
    startTime: number,
    target: string | undefined,
  ): Promise<void> {
    const metrics = getMetrics();
    const logger = getRequestLogger();
    const durationMs = Date.now() - startTime;
    const provider = target ?? "unknown";

    if (streamError && acc.chunks === 0) {
      // Failed before any output: same accounting as a failed route().
      pluginCtx.error = streamError;
      await this.pluginManager.runOnError(pluginCtx);
      void logger.logRequest({
        timestamp: new Date().toISOString(),
        requestId: ctx.traceId ?? "",
        model: originalReq.model,
        provider: "unknown",
        strategy: this.config.strategy.mode,
        durationMs,
        error: streamError.message,
      });
      return;
    }

    const usage: Usage = acc.usage ?? estimateStreamUsage(finalReq, acc);
    const response: ChatCompletionResponse = {
      id: acc.id,
      object: "chat.completion",
      created: acc.created,
      model: acc.model,
      provider,
      choices: [{
        index: 0,
        message: { role: "assistant", content: acc.content },
        finishReason: acc.finishReason,
      }],
      usage,
      metadata: acc.usage ? undefined : { usageEstimated: true },
    };
    pluginCtx.response = response;
    if (streamError) {
      // Failed mid-stream: tokens were still consumed, so after-request
      // plugins (budget) run too, with the error visible to them.
      pluginCtx.error = streamError;
      await this.pluginManager.runOnError(pluginCtx);
    }
    await this.pluginManager.runAfter(pluginCtx);

    if (usage) metrics.recordTokens(provider, acc.model, usage.promptTokens, usage.completionTokens);
    void logger.logRequest({
      timestamp: new Date().toISOString(),
      requestId: ctx.traceId ?? "",
      model: acc.model,
      provider,
      strategy: this.config.strategy.mode,
      durationMs,
      tokens: {
        prompt: usage.promptTokens,
        completion: usage.completionTokens,
        total: usage.totalTokens,
      },
      ...(streamError ? { error: streamError.message } : {}),
    });
  }

  /**
   * Embedding request with plugin lifecycle. The input is presented to the
   * before-request plugins as one user message per input item, and the
   * upstream request is rebuilt from the (possibly modified) plugin request,
   * so word-filter redaction, model rewrites, etc. apply. A short-circuit
   * returns metadata["_embeddingResponse"] when a plugin supplied one;
   * otherwise it is rejected (a chat response cannot answer an embedding).
   */
  async embedWithPlugins(
    ctx: RequestContext,
    req: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    const items: readonly string[] = typeof req.input === "string" ? [req.input] : req.input;
    const pluginCtx = createPluginContext({
      model: req.model,
      messages: items.map((text) => ({ role: "user" as const, content: text })),
    }, ctx);
    pluginCtx.metadata["_surface"] = "embedding";
    const startTime = Date.now();

    await this.runBeforeRecordingRejection(pluginCtx, ctx, req.model, "embedding", startTime);

    if (pluginCtx._shortCircuited) {
      const supplied = pluginCtx.metadata["_embeddingResponse"];
      if (isEmbeddingResponse(supplied)) {
        this.recordPluginBlocked(ctx, req.model, "embedding", startTime, pluginCtx);
        return supplied;
      }
      const rejection = new PluginRejectionError(
        "before_request",
        "Plugin short-circuited an embedding request without supplying an embedding response",
        pluginCtx._shortCircuitedBy,
      );
      this.recordPluginBlocked(ctx, req.model, "embedding", startTime, rejection);
      throw rejection;
    }

    const texts = pluginCtx.request.messages.map((m) => messageText(m.content));
    const upstreamReq: EmbeddingRequest = {
      ...req,
      model: pluginCtx.request.model,
      input: typeof req.input === "string" && texts.length === 1 ? texts[0]! : texts,
    };

    let response: EmbeddingResponse;
    try {
      response = await this.embed(ctx, upstreamReq);
    } catch (err) {
      pluginCtx.error = err instanceof Error ? err : new Error(String(err));
      await this.pluginManager.runOnError(pluginCtx);
      throw err;
    }

    pluginCtx.metadata["_embeddingResponse"] = response;
    // Expose usage to after-request plugins (e.g. budget) as a chat-shaped response.
    const promptTokens = response.usage?.promptTokens ?? 0;
    pluginCtx.response = {
      id: "",
      object: "embedding",
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      provider: response.provider,
      choices: [],
      usage: { promptTokens, completionTokens: 0, totalTokens: response.usage?.totalTokens ?? promptTokens },
    };
    await this.pluginManager.runAfter(pluginCtx);
    return response;
  }

  /**
   * Image generation request with plugin lifecycle. The upstream prompt is
   * rebuilt from the (possibly modified) plugin request. A short-circuit
   * returns metadata["_imageResponse"] when a plugin supplied one; otherwise
   * it is rejected.
   */
  async generateImageWithPlugins(
    ctx: RequestContext,
    req: ImageRequest,
  ): Promise<ImageResponse> {
    const pluginCtx = createPluginContext({
      model: req.model,
      messages: [{ role: "user", content: req.prompt }],
    }, ctx);
    pluginCtx.metadata["_surface"] = "image";
    const startTime = Date.now();

    await this.runBeforeRecordingRejection(pluginCtx, ctx, req.model, "image", startTime);

    if (pluginCtx._shortCircuited) {
      const supplied = pluginCtx.metadata["_imageResponse"];
      if (isImageResponse(supplied)) {
        this.recordPluginBlocked(ctx, req.model, "image", startTime, pluginCtx);
        return supplied;
      }
      const rejection = new PluginRejectionError(
        "before_request",
        "Plugin short-circuited an image request without supplying an image response",
        pluginCtx._shortCircuitedBy,
      );
      this.recordPluginBlocked(ctx, req.model, "image", startTime, rejection);
      throw rejection;
    }

    const upstreamReq: ImageRequest = {
      ...req,
      model: pluginCtx.request.model,
      prompt: pluginCtx.request.messages.map((m) => messageText(m.content)).join("\n"),
    };

    let response: ImageResponse;
    try {
      response = await this.generateImage(ctx, upstreamReq);
    } catch (err) {
      pluginCtx.error = err instanceof Error ? err : new Error(String(err));
      await this.pluginManager.runOnError(pluginCtx);
      throw err;
    }

    pluginCtx.metadata["_imageResponse"] = response;
    await this.pluginManager.runAfter(pluginCtx);
    return response;
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
    const resolved = this.resolveAlias(request);
    const pluginCtx = createPluginContext(resolved, ctx);
    pluginCtx.metadata["_surface"] = "passthrough";
    const startTime = Date.now();
    await this.runBeforeRecordingRejection(pluginCtx, ctx, request.model, "passthrough", startTime);
    let rejection: PluginRejectionError | undefined;
    if (pluginCtx._shortCircuited) {
      rejection = new PluginRejectionError(
        "before_request",
        "Plugin short-circuit is not supported on pass-through proxy routes",
        pluginCtx._shortCircuitedBy,
      );
    } else if (JSON.stringify(pluginCtx.request.messages) !== JSON.stringify(resolved.messages)) {
      rejection = new PluginRejectionError(
        "before_request",
        "Request content was modified by a plugin; pass-through proxy routes cannot forward modified content",
        pluginCtx._modifiedBy?.join(","),
      );
    }
    if (rejection) {
      this.recordPluginBlocked(ctx, request.model, "passthrough", startTime, rejection);
      throw rejection;
    }
    const view = pluginCtx.request;
    return applyPassthroughMaxTokens(obj, tokenField, view.maxTokens ?? view.maxCompletionTokens);
  }

  /** runBefore(), recording a plugin rejection in the request log / metrics before rethrowing it. */
  private async runBeforeRecordingRejection(
    pluginCtx: ReturnType<typeof createPluginContext>,
    ctx: RequestContext,
    model: string,
    surface: string,
    startTime: number,
  ): Promise<void> {
    try {
      await this.pluginManager.runBefore(pluginCtx);
    } catch (err) {
      if (err instanceof PluginRejectionError) {
        this.recordPluginBlocked(ctx, model, surface, startTime, err);
      }
      throw err;
    }
  }

  /**
   * Request-log entry and metrics for a request that a before-request plugin
   * ended without any upstream call: rejected (answered 403) or
   * short-circuited with the plugin's own response (answered 200). Called
   * exactly once per such request; provider is "none" (no upstream target).
   */
  private recordPluginBlocked(
    ctx: RequestContext,
    model: string,
    surface: string,
    startTime: number,
    cause: PluginRejectionError | ReturnType<typeof createPluginContext>,
  ): void {
    const rejected = cause instanceof PluginRejectionError;
    const plugin = (rejected ? cause.plugin : cause._shortCircuitedBy) ?? "unknown";
    const outcome = rejected ? "plugin_rejected" : "plugin_short_circuit";
    const durationMs = Date.now() - startTime;
    const metrics = getMetrics();
    metrics.recordPluginBlocked(plugin, outcome, surface);
    void getRequestLogger().logRequest({
      timestamp: new Date().toISOString(),
      requestId: ctx.traceId ?? "",
      model,
      provider: NO_UPSTREAM_PROVIDER,
      strategy: this.config.strategy.mode,
      durationMs,
      status: rejected ? cause.status : 200,
      plugin,
      surface,
      outcome,
      ...(rejected ? { error: cause.reason } : {}),
    });
  }

  /**
   * Embedding request, routed through the configured strategy like chat:
   * candidates are the strategy's ordered targets that support the model and
   * embeddings, each guarded by its circuit breaker and concurrency limiter,
   * with retry and failover (see routing/executor.ts).
   */
  async embed(
    ctx: RequestContext,
    req: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    const model = this.aliases[req.model] ?? req.model;
    return this.routeAuxiliary(ctx, model, "embed", "embedding", "embeddings",
      (p) => (p as IEmbeddingProvider).embed(ctx, { ...req, model }));
  }

  /** Image generation request, routed through the strategy (see embed()). */
  async generateImage(
    ctx: RequestContext,
    req: ImageRequest,
  ): Promise<ImageResponse> {
    const model = this.aliases[req.model] ?? req.model;
    return this.routeAuxiliary(ctx, model, "generateImage", "image", "image generation",
      (p) => (p as IImageProvider).generateImage(ctx, { ...req, model }));
  }

  /**
   * Non-streaming, non-chat request (embeddings, images) through the shared
   * candidate executor. Candidate order comes from the strategy's
   * selectTargets() (fallback order, weighted pick, cost ranking, ...),
   * filtered to targets that support the model and the capability. When no
   * strategy target qualifies, the first registered provider supporting the
   * model is used (previous behavior), still behind its breaker / limiter.
   */
  private async routeAuxiliary<T>(
    ctx: RequestContext,
    model: string,
    capability: "embed" | "generateImage",
    kind: string,
    capabilityLabel: string,
    call: (provider: IProvider) => Promise<T>,
  ): Promise<T> {
    let ordered: readonly string[] = [];
    try {
      ordered = this.strategy.selectTargets({ model, messages: [] });
    } catch {
      ordered = [];
    }
    const candidates = [...new Set(ordered)].filter((name) => {
      const p = this.registry.get(name);
      return !!p && capability in p && p.supportsModel(model);
    });
    if (candidates.length === 0) {
      const provider = this.registry.findByModel(model);
      if (!provider) {
        throw modelNotFound(`No provider found for ${kind} model "${model}"`);
      }
      if (!(capability in provider)) {
        throw invalidRequest(`The model "${model}" does not support ${capabilityLabel}`, "unsupported_capability");
      }
      candidates.push(provider.name);
    }
    try {
      return await this.executor.run(ctx, candidates, (p) => call(p), {
        label: `Gateway(${kind})`,
        supports: (p) => capability in p,
      });
    } catch (err) {
      throw this.translateConcurrencyError(err);
    }
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

  // ── Internal ──

  /**
   * Translate a per-target concurrency limit rejection into a 429 ProviderError
   * so the HTTP handler surfaces it as HTTP 429 (queue-full backpressure).
   */
  private translateConcurrencyError(err: unknown): unknown {
    if (err instanceof ConcurrencyLimitError || err instanceof CircuitOpenError) {
      return toGatewayError(err);
    }
    return err;
  }

  /** Strategy-ordered candidates through the executor (non-streaming chat). */
  private async executeWithCircuitBreaker(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    try {
      return await executeChat(this.executor, this.strategy, ctx, req);
    } catch (err) {
      throw this.translateConcurrencyError(err);
    }
  }

  private resolveAlias(req: ChatCompletionRequest): ChatCompletionRequest {
    const alias = this.aliases[req.model];
    if (alias) {
      return { ...req, model: alias };
    }
    return req;
  }
}

/** Provider label for requests that never reached an upstream target. */
const NO_UPSTREAM_PROVIDER = "none";


interface StreamAccumulator {
  id: string;
  created: number;
  model: string;
  content: string;
  toolArgChars: number;
  finishReason: string;
  usage: Usage | undefined;
  chunks: number;
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

function accumulateChunk(acc: StreamAccumulator, chunk: StreamChunk): void {
  acc.chunks++;
  if (chunk.id) acc.id = chunk.id;
  if (chunk.model) acc.model = chunk.model;
  if (typeof chunk.created === "number") acc.created = chunk.created;
  if (chunk.usage) acc.usage = chunk.usage;
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;
    if (delta) {
      if (typeof delta.content === "string") acc.content += delta.content;
      for (const tc of delta.toolCalls ?? []) {
        const args = (tc as { function?: { arguments?: unknown; name?: unknown } }).function;
        if (typeof args?.arguments === "string") acc.toolArgChars += args.arguments.length;
        if (typeof args?.name === "string") acc.toolArgChars += args.name.length;
      }
    }
    if (choice.finishReason) acc.finishReason = choice.finishReason;
  }
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function estimateStreamUsage(req: ChatCompletionRequest, acc: StreamAccumulator): Usage {
  let promptChars = 0;
  for (const msg of req.messages) {
    if (typeof msg.content === "string") promptChars += msg.content.length;
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part.text === "string") promptChars += part.text.length;
      }
    }
  }
  const promptTokens = estimateTokens(promptChars);
  const completionTokens = estimateTokens(acc.content.length + acc.toolArgChars);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function messageText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

function isEmbeddingResponse(v: unknown): v is EmbeddingResponse {
  return v !== null && typeof v === "object" && Array.isArray((v as { data?: unknown }).data);
}

function isImageResponse(v: unknown): v is ImageResponse {
  return v !== null && typeof v === "object" && Array.isArray((v as { data?: unknown }).data);
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
