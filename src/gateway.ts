/**
 * Gateway core — routes requests through providers, strategies, and plugins.
 *
 * The central orchestrator that wires together:
 *   ProviderRegistry → IStrategy → PluginManager
 *
 * route()  — non-streaming request flow
 * routeStream() — streaming request flow with fallback
 */

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
import { createOpenAICompatProvider, ProviderError } from "./providers/openai-compat.js";
import type { IStrategy, StrategyMode } from "./routing/types.js";
import { createStrategy } from "./routing/strategy-factory.js";
import { resolveStrategyMode } from "./config/removed.js";
import type { StrategyConfig as RoutingStrategyConfig } from "./routing/strategy-factory.js";
import { PluginManager } from "./plugins/manager.js";
import { createPluginContext } from "./plugins/context.js";
import { PluginRejectionError } from "./plugins/error.js";
import type { IPlugin, Stage } from "./plugins/types.js";
import { buildPluginsFromConfig } from "./plugins/builtins/from-config.js";
import type { GatewayConfig, TargetConfig } from "./config/types.js";
import { expandTargetEnvRefs } from "./config/envref.js";
import { getMetrics } from "./metrics/metrics.js";
import { getTracer } from "./observability/otel-tracer.js";
import { getRequestLogger } from "./observability/request-log.js";
import { McpRegistry } from "./mcp/registry.js";
import { McpExecutor } from "./mcp/executor.js";
import { CircuitBreakerRegistry, CircuitOpenError } from "./routing/circuit-breaker.js";
import { isBreakerFailure, isTimeoutAbort } from "./routing/outcome.js";
import { executeCandidates } from "./routing/executor.js";
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

// ── Provider factory registry ──

/** Factory function that creates a provider from a TargetConfig. */
type ProviderFactory = (target: TargetConfig) => IProvider;

const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  openai: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.openai.com/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  deepseek: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.deepseek.com/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  groq: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.groq.com/openai/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  mistral: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.mistral.ai/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  xai: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.x.ai/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  qwen: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  moonshot: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.moonshot.cn/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  together: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.together.xyz/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  fireworks: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.fireworks.ai/inference/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  deepinfra: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.deepinfra.com/v1/openai",
    apiKey: t.apiKey,
    models: t.models,
  }),
  ai21: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.ai21.com/studio/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  cerebras: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.cerebras.ai/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  sambanova: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.sambanova.ai/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  novita: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.novita.ai/v3/openai",
    apiKey: t.apiKey,
    models: t.models,
  }),
  nvidia_nim: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://integrate.api.nvidia.com/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  ollama: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "http://localhost:11434/v1",
    apiKey: t.apiKey || "ollama",
    models: t.models,
  }),
  openrouter: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://openrouter.ai/api/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  perplexity: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.perplexity.ai",
    apiKey: t.apiKey,
    models: t.models,
  }),
  replicate: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.replicate.com/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
  cloudflare: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api.cloudflare.com/client/v4/accounts",
    apiKey: t.apiKey,
    models: t.models,
  }),
  databricks: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://.databricks.com/serving-endpoints",
    apiKey: t.apiKey,
    models: t.models,
  }),
  huggingface: (t) => createOpenAICompatProvider({
    name: t.name,
    baseURL: t.baseURL ?? "https://api-inference.huggingface.co/v1",
    apiKey: t.apiKey,
    models: t.models,
  }),
};

function createProviderFromTarget(rawTarget: TargetConfig): IProvider {
  // Resolve ${VAR} references at construction time (config keeps templates).
  const target = expandTargetEnvRefs(rawTarget);
  const factory = PROVIDER_FACTORIES[target.provider];
  if (!factory) {
    // Fallback: treat as generic OpenAI-compatible with explicit baseURL
    if (target.baseURL) {
      return createOpenAICompatProvider({
        name: target.name,
        baseURL: target.baseURL,
        apiKey: target.apiKey,
        models: target.models,
      });
    }
    throw new Error(`Unknown provider "${target.provider}" and no baseURL provided for target "${target.name}"`);
  }
  return factory(target);
}

// ── Config → Strategy config bridge ──

function buildStrategyConfig(config: GatewayConfig): {
  mode: StrategyMode;
  config: RoutingStrategyConfig;
} {
  const sc = config.strategy;
  const targetNames = config.targets.map((t) => t.name);
  // Per-target retry config, honored by every multi-target strategy's
  // candidate executor (a target without one gets a single attempt).
  const retryConfigs = new Map<string, import("./config/types.js").RetryConfig>();
  for (const t of config.targets) {
    if (t.retry) retryConfigs.set(t.name, t.retry);
  }

  const mode = resolveStrategyMode(sc.mode);
  switch (mode) {
    case "single": {
      const target = sc.targets?.[0] ?? targetNames[0];
      if (!target) throw new Error("single strategy requires at least one target");
      return { mode: "single", config: { target } };
    }
    case "fallback": {
      const fallbackTargets = sc.targets ?? targetNames;
      return { mode: "fallback", config: { targets: fallbackTargets, retryConfigs } };
    }
    case "loadbalance": {
      // Weight 0 drains a target: it gets no traffic (not even as failover).
      const targets = (sc.targets ?? targetNames).map((name) => {
        const t = config.targets.find((tgt) => tgt.name === name);
        return { name, weight: t?.weight ?? sc.weights?.[name] ?? 1 };
      });
      return { mode: "loadbalance", config: { targets, retryConfigs } };
    }
    case "conditional": {
      return {
        mode: "conditional",
        config: {
          rules: sc.rules ?? [],
          defaultTarget: sc.targets?.[0] ?? targetNames[0],
          retryConfigs,
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
  /** Target that produced each in-flight stream (see tagStreamProvider). */
  private readonly streamServedBy = new WeakMap<RequestContext, string>();

  constructor(config: GatewayConfig) {
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
      const provider = createProviderFromTarget(target);
      this.registry.register(provider);
      if (target.circuitBreaker) {
        this.circuitBreakers.getOrCreate(target.name, target.circuitBreaker);
      }
      this.ensureConcurrencyLimiter(target);
    }

    const { mode, config: strategyConfig } = buildStrategyConfig(config);
    this.strategy = createStrategy(mode, strategyConfig, (name: string) =>
      this.tagStreamProvider(name, this.guardProvider(name, this.limitProvider(name, this.registry.get(name)))),
    );

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
      response = await this.mcpExecutor.executeAgenticLoop(ctx, finalReq, response, this.strategy);
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
    let streamError: Error | undefined;
    let finalized = false;
    const finalize = async (): Promise<void> => {
      if (finalized) return;
      finalized = true;
      try {
        await this.finalizeStream(ctx, req, finalReq, pluginCtx, acc, streamError, startTime);
      } catch (err) {
        console.error(`[gateway] stream finalization failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // Circuit breaking is applied per invoked target (see guardProvider).
    try {
      for await (const chunk of this.strategy.executeStream(ctx, finalReq)) {
        accumulateChunk(acc, chunk);
        yield chunk;
      }
    } catch (err) {
      const translated = this.translateConcurrencyError(err);
      streamError = translated instanceof Error ? translated : new Error(String(translated));
      throw translated;
    } finally {
      tracer.endSpan(span);
      await finalize();
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
  ): Promise<void> {
    const metrics = getMetrics();
    const logger = getRequestLogger();
    const durationMs = Date.now() - startTime;
    const provider = (ctx !== null && typeof ctx === "object" ? this.streamServedBy.get(ctx) : undefined) ?? "unknown";

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
   */
  async runPassthroughBeforePlugins(ctx: RequestContext, bodyText: string | undefined): Promise<void> {
    let body: unknown;
    try {
      body = bodyText !== undefined && bodyText !== "" ? JSON.parse(bodyText) : undefined;
    } catch {
      body = undefined;
    }
    const obj = body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const request: ChatCompletionRequest = {
      model: typeof obj["model"] === "string" ? obj["model"] : "",
      messages: extractPassthroughMessages(obj),
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
      status: rejected ? PLUGIN_REJECTION_STATUS : 200,
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
    let ordered: string[] = [];
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
        throw new Error(`No provider found for ${kind} model "${model}"`);
      }
      if (!(capability in provider)) {
        throw new Error(`Provider "${provider.name}" does not support ${capabilityLabel}`);
      }
      candidates.push(provider.name);
    }
    try {
      return await executeCandidates(
        ctx,
        candidates,
        (name) => this.guardProvider(name, this.limitProvider(name, this.registry.get(name))),
        (p) => call(p),
        {
          label: `Gateway(${kind})`,
          retryConfigFor: (name) => this.config.targets.find((t) => t.name === name)?.retry,
        },
        (p) => capability in p,
      );
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
   * Record which target actually produced a stream (the one whose first
   * chunk arrived), keyed by request context, for stream metrics and
   * request logs. Pure observation: does not alter the stream.
   */
  private tagStreamProvider(
    name: string,
    provider: IProvider | undefined,
  ): IProvider | undefined {
    if (!provider || !("completeStream" in provider)) return provider;
    const servedBy = this.streamServedBy;
    const streamer = provider as IProvider & {
      completeStream(ctx: RequestContext, req: ChatCompletionRequest): AsyncIterable<StreamChunk>;
    };
    // Inherit from the provider (keeps class-based providers' prototype
    // methods) and override only completeStream.
    const tagged = Object.create(provider) as IProvider;
    return Object.assign(tagged, {
      completeStream: async function* (
        ctx: RequestContext,
        req: ChatCompletionRequest,
      ): AsyncIterable<StreamChunk> {
        let tagged = false;
        for await (const chunk of streamer.completeStream(ctx, req)) {
          if (!tagged) {
            if (ctx !== null && typeof ctx === "object") servedBy.set(ctx, name);
            tagged = true;
          }
          yield chunk;
        }
      },
    });
  }

  /**
   * Decorate a provider with its per-target concurrency limiter when one is
   * configured. The limiter sits INNERMOST — around only the upstream call —
   * so an open circuit breaker fails fast without occupying a slot, matching
   * the Go decoration order (limiter innermost, circuit breaker outermost).
   * When the queue is full the caller receives a ConcurrencyLimitError, which
   * the gateway converts to an upstream 429.
   */
  private limitProvider(
    name: string,
    provider: IProvider | undefined,
  ): IProvider | undefined {
    if (!provider) return undefined;
    const limiter = this.concurrencyLimiters.get(name);
    if (!limiter) return provider;

    const limited = {
      ...provider,
      complete: async (
        ctx: RequestContext,
        req: ChatCompletionRequest,
      ): Promise<ChatCompletionResponse> => {
        const granted = limiter.acquire();
        if (granted === false) throw new ConcurrencyLimitError(name);
        try {
          if (granted instanceof Promise) await granted;
          return await provider.complete(ctx, req);
        } finally {
          limiter.release();
        }
      },
    } as IProvider;

    if ("completeStream" in provider) {
      const streamer = provider as IProvider & {
        completeStream(
          ctx: RequestContext,
          req: ChatCompletionRequest,
        ): AsyncIterable<StreamChunk>;
      };
      (limited as IProvider & {
        completeStream(
          ctx: RequestContext,
          req: ChatCompletionRequest,
        ): AsyncIterable<StreamChunk>;
      }).completeStream = async function* (
        ctx: RequestContext,
        req: ChatCompletionRequest,
      ): AsyncIterable<StreamChunk> {
        const granted = limiter.acquire();
        if (granted === false) throw new ConcurrencyLimitError(name);
        try {
          if (granted instanceof Promise) await granted;
          yield* streamer.completeStream(ctx, req);
        } finally {
          limiter.release();
        }
      };
    }

    const withSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
      const granted = limiter.acquire();
      if (granted === false) throw new ConcurrencyLimitError(name);
      try {
        if (granted instanceof Promise) await granted;
        return await fn();
      } finally {
        limiter.release();
      }
    };
    wrapAuxiliaryCalls(provider, limited, (_ctx, fn) => withSlot(fn));

    return limited;
  }

  /**
   * Decorate a provider with its circuit breaker (OUTERMOST, around the
   * concurrency limiter). The breaker is consulted on every actual invocation
   * of this target, so an open breaker rejects with CircuitOpenError (letting
   * fallback move on) and success/failure is recorded only for the target that
   * was really called. Client aborts and local concurrency rejections are not
   * counted as upstream failures.
   */
  private guardProvider(
    name: string,
    provider: IProvider | undefined,
  ): IProvider | undefined {
    if (!provider) return undefined;
    const breakers = (): CircuitBreakerRegistry => this.circuitBreakers;
    if (!breakers().get(name)) return provider;

    const enter = () => {
      const breaker = breakers().get(name);
      if (!breaker) return undefined;
      const permit = breaker.acquire();
      if (!permit) throw new CircuitOpenError(name);
      return { breaker, permit };
    };
    type Entry = ReturnType<typeof enter>;

    /**
     * Settle a failed attempt and return the error to rethrow. Every admitted
     * attempt must end in recordSuccess, recordFailure or release — otherwise
     * a HALF_OPEN probe permit leaks and the breaker wedges.
     *  - gateway request timeout (signal reason TimeoutError) before output:
     *    upstream too slow -> failure, surfaced as a 504 ProviderError;
     *  - client abort: no health signal (success if output had started);
     *  - local concurrency rejection / caller-caused 4xx: no health signal;
     *  - anything else (network, 5xx, 408, 429, broken stream): failure.
     */
    const fail = (entry: Entry, ctx: RequestContext, err: unknown, started = false): unknown => {
      if (!entry) {
        return isTimeoutAbort(ctx.signal) && !started ? timeoutError(name) : err;
      }
      const { breaker, permit } = entry;
      if (err instanceof ConcurrencyLimitError) {
        breaker.release(permit);
        return err;
      }
      if (isTimeoutAbort(ctx.signal)) {
        if (started) {
          // Output was flowing; a total-request timeout mid-stream says little
          // about upstream health.
          breaker.release(permit);
          return err;
        }
        breaker.recordFailure();
        return timeoutError(name);
      }
      if (isAbortError(err) || ctx.signal?.aborted) {
        if (started) breaker.recordSuccess();
        else breaker.release(permit);
        return err;
      }
      if (!isBreakerFailure(err)) {
        breaker.release(permit);
        return err;
      }
      breaker.recordFailure();
      return err;
    };

    const guarded = {
      ...provider,
      complete: async (
        ctx: RequestContext,
        req: ChatCompletionRequest,
      ): Promise<ChatCompletionResponse> => {
        const entry = enter();
        try {
          const res = await provider.complete(ctx, req);
          entry?.breaker.recordSuccess();
          return res;
        } catch (err) {
          throw fail(entry, ctx, err);
        }
      },
    } as IProvider;

    if ("completeStream" in provider) {
      const streamer = provider as IProvider & {
        completeStream(
          ctx: RequestContext,
          req: ChatCompletionRequest,
        ): AsyncIterable<StreamChunk>;
      };
      (guarded as IProvider & {
        completeStream(
          ctx: RequestContext,
          req: ChatCompletionRequest,
        ): AsyncIterable<StreamChunk>;
      }).completeStream = async function* (
        ctx: RequestContext,
        req: ChatCompletionRequest,
      ): AsyncIterable<StreamChunk> {
        const entry = enter();
        let started = false;
        let settled = false;
        try {
          for await (const chunk of streamer.completeStream(ctx, req)) {
            started = true;
            yield chunk;
          }
          settled = true;
          entry?.breaker.recordSuccess();
        } catch (err) {
          settled = true;
          throw fail(entry, ctx, err, started);
        } finally {
          if (!settled && entry) {
            // Consumer stopped early. With output, upstream was healthy;
            // without any, there is no signal: return the probe permit.
            if (started) entry.breaker.recordSuccess();
            else entry.breaker.release(entry.permit);
          }
        }
      };
    }

    wrapAuxiliaryCalls(provider, guarded, async (ctx, fn) => {
      const entry = enter();
      try {
        const res = await fn();
        entry?.breaker.recordSuccess();
        return res;
      } catch (err) {
        throw fail(entry, ctx, err);
      }
    });

    return guarded;
  }

  /**
   * Translate a per-target concurrency limit rejection into a 429 ProviderError
   * so the HTTP handler surfaces it as HTTP 429 (queue-full backpressure).
   */
  private translateConcurrencyError(err: unknown): unknown {
    if (err instanceof ConcurrencyLimitError) {
      return new ProviderError(err.target, 429, err.message);
    }
    if (err instanceof CircuitOpenError) {
      return new ProviderError(err.target, 503, err.message);
    }
    return err;
  }

  private async executeWithCircuitBreaker(
    ctx: RequestContext,
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    // Circuit breaking is applied per invoked target (see guardProvider).
    try {
      return await this.strategy.execute(ctx, req);
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
/** HTTP status every handler answers a PluginRejectionError with. */
const PLUGIN_REJECTION_STATUS = 403;

function timeoutError(target: string): ProviderError {
  return new ProviderError(target, 504, `upstream "${target}" timed out (gateway request timeout)`);
}

function isAbortError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}

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

type AuxiliaryWrapper = <T>(ctx: RequestContext, fn: () => Promise<T>) => Promise<T>;

/**
 * Copy a provider's optional embed / generateImage methods onto a decorated
 * provider, each call running inside `wrap` (breaker or concurrency slot).
 * Decorators build plain objects, so prototype methods would otherwise be
 * lost (or bypass the decoration).
 */
function wrapAuxiliaryCalls(source: IProvider, target: IProvider, wrap: AuxiliaryWrapper): void {
  const out = target as unknown as Record<string, unknown>;
  if ("embed" in source) {
    const p = source as IEmbeddingProvider;
    out["embed"] = (ctx: RequestContext, req: EmbeddingRequest) => wrap(ctx, () => p.embed(ctx, req));
  }
  if ("generateImage" in source) {
    const p = source as IImageProvider;
    out["generateImage"] = (ctx: RequestContext, req: ImageRequest) => wrap(ctx, () => p.generateImage(ctx, req));
  }
}
