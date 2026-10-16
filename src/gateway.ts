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
} from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createOpenAICompatProvider, ProviderError } from "./providers/openai-compat.js";
import type { IStrategy, StrategyMode } from "./routing/types.js";
import { createStrategy } from "./routing/strategy-factory.js";
import type {
  SingleConfig,
  FallbackConfig,
  LoadBalanceConfig,
  ConditionalConfig,
  LeastLatencyConfig,
  CostOptimizedConfig,
  ContentBasedConfig,
  AbTestConfig,
} from "./routing/strategy-factory.js";
import { PluginManager } from "./plugins/manager.js";
import { createPluginContext } from "./plugins/context.js";
import { PluginRejectionError } from "./plugins/error.js";
import type { IPlugin, Stage } from "./plugins/types.js";
import type { GatewayConfig, TargetConfig } from "./config/types.js";
import { getMetrics } from "./observability/metrics.js";
import { getTracer } from "./observability/tracing.js";
import { getRequestLogger } from "./observability/request-log.js";
import { McpRegistry } from "./mcp/registry.js";
import { McpExecutor } from "./mcp/executor.js";
import { CircuitBreakerRegistry, CircuitOpenError } from "./routing/circuit-breaker.js";
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

function createProviderFromTarget(target: TargetConfig): IProvider {
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
  config: SingleConfig | FallbackConfig | LoadBalanceConfig | ConditionalConfig | LeastLatencyConfig | CostOptimizedConfig | ContentBasedConfig | AbTestConfig;
} {
  const sc = config.strategy;
  const targetNames = config.targets.map((t) => t.name);

  switch (sc.mode) {
    case "single": {
      const target = sc.targets?.[0] ?? targetNames[0];
      if (!target) throw new Error("single strategy requires at least one target");
      return { mode: "single", config: { target } };
    }
    case "fallback": {
      const fallbackTargets = sc.targets ?? targetNames;
      const retryConfigs = new Map<string, import("./config/types.js").RetryConfig>();
      for (const name of fallbackTargets) {
        const t = config.targets.find((tgt) => tgt.name === name);
        if (t?.retry) retryConfigs.set(name, t.retry);
      }
      return { mode: "fallback", config: { targets: fallbackTargets, retryConfigs } };
    }
    case "loadbalance": {
      const targets = (sc.targets ?? targetNames).map((name) => {
        const t = config.targets.find((tgt) => tgt.name === name);
        return { name, weight: t?.weight ?? sc.weights?.[name] ?? 1 };
      });
      return { mode: "loadbalance", config: { targets } };
    }
    case "conditional": {
      // Go-style conditions (key/value/targetKey) are bridged to TS
      // field/pattern/target rules: the condition key becomes the field and
      // the condition value becomes the regex pattern.
      const rules =
        sc.rules ??
        (sc.conditions ?? []).map((c) => ({
          field: c.key,
          pattern: c.value,
          target: c.targetKey,
        }));
      return {
        mode: "conditional",
        config: {
          rules,
          defaultTarget: sc.targets?.[0] ?? targetNames[0],
        },
      };
    }
    case "least_latency": {
      return { mode: "least_latency", config: { targets: sc.targets ?? targetNames } };
    }
    case "cost_optimized": {
      const targets = (sc.targets ?? targetNames).map((name) => {
        const t = config.targets.find((tgt) => tgt.name === name);
        return {
          name,
          costPer1kInputTokens: t?.costPer1kInputTokens ?? 0,
          costPer1kOutputTokens: t?.costPer1kOutputTokens ?? 0,
        };
      });
      return {
        mode: "cost_optimized",
        config: {
          targets,
          unpricedStrategy: sc.unpricedStrategy ?? "fallback",
        },
      };
    }
    case "content_based": {
      const keywords = sc.keywords
        ? Object.entries(sc.keywords).map(([keyword, target]) => ({ keyword, target }))
        : [];
      // Go-style content_conditions are bridged to ContentBasedRule.
      const contentConditions = (sc.contentConditions ?? []).map((cc) => ({
        type: cc.type as "prompt_contains" | "prompt_not_contains" | "prompt_regex",
        value: cc.value,
        target: cc.targetKey,
      }));
      return {
        mode: "content_based",
        config: {
          keywords,
          contentConditions,
          defaultTarget: sc.targets?.[0] ?? targetNames[0],
        },
      };
    }
    case "abtest": {
      // Prefer Go-style ab_variants when configured.
      const variants = sc.abVariants && sc.abVariants.length > 0
        ? sc.abVariants.map((v) => ({
            name: v.targetKey,
            weight: v.weight,
          }))
        : (sc.targets ?? targetNames).map((name) => ({
            name,
            weight: sc.weights?.[name] ?? 1,
          }));
      return { mode: "abtest", config: { variants } };
    }
    default: {
      const _exhaustive: never = sc.mode;
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

  constructor(config: GatewayConfig) {
    this.config = config;
    this.aliases = config.aliases ?? {};
    this.registry = new ProviderRegistry();
    this.pluginManager = new PluginManager();
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
      this.guardProvider(name, this.limitProvider(name, this.registry.get(name))),
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
    for (const serverConfig of this.config.mcpServers) {
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
    }
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

    const pluginCtx = createPluginContext(resolved);
    try {
      await this.pluginManager.runBefore(pluginCtx);
    } catch (err) {
      tracer.endSpan(span);
      if (err instanceof PluginRejectionError) throw err;
      throw err;
    }

    if (pluginCtx._shortCircuited && pluginCtx.response) {
      tracer.endSpan(span);
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
      logger.logRequest({
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
    metrics.recordRequest(provider, response.model, durationMs, response.usage);

    logger.logRequest({
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

    const resolved = this.resolveAlias(req);

    const pluginCtx = createPluginContext(resolved);
    try {
      await this.pluginManager.runBefore(pluginCtx);
    } catch (err) {
      tracer.endSpan(span);
      if (err instanceof PluginRejectionError) throw err;
      throw err;
    }

    if (pluginCtx._shortCircuited) {
      tracer.endSpan(span);
      throw new PluginRejectionError(
        "before_request",
        "Plugin short-circuited during streaming request; short-circuit is not supported for streaming",
      );
    }

    let finalReq = pluginCtx.request;

    if (this.mcpExecutor) {
      finalReq = this.mcpExecutor.injectTools(finalReq);
    }

    // Circuit breaking is applied per invoked target (see guardProvider).
    try {
      yield* this.strategy.executeStream(ctx, finalReq);
    } catch (err) {
      throw this.translateConcurrencyError(err);
    } finally {
      tracer.endSpan(span);
    }
  }

  /** Embedding request with plugin lifecycle. */
  async embedWithPlugins(
    ctx: RequestContext,
    req: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    const pluginCtx = createPluginContext({
      model: req.model,
      messages: [{ role: "user", content: typeof req.input === "string" ? req.input : req.input.join("\n") }],
    });
    pluginCtx.metadata["_surface"] = "embedding";

    try {
      await this.pluginManager.runBefore(pluginCtx);
    } catch (err) {
      if (err instanceof PluginRejectionError) throw err;
      throw err;
    }

    let response: EmbeddingResponse;
    try {
      response = await this.embed(ctx, req);
    } catch (err) {
      pluginCtx.error = err instanceof Error ? err : new Error(String(err));
      await this.pluginManager.runOnError(pluginCtx);
      throw err;
    }

    pluginCtx.metadata["_embeddingResponse"] = response;
    await this.pluginManager.runAfter(pluginCtx);
    return response;
  }

  /** Image generation request with plugin lifecycle. */
  async generateImageWithPlugins(
    ctx: RequestContext,
    req: ImageRequest,
  ): Promise<ImageResponse> {
    const pluginCtx = createPluginContext({
      model: req.model,
      messages: [{ role: "user", content: req.prompt }],
    });
    pluginCtx.metadata["_surface"] = "image";

    try {
      await this.pluginManager.runBefore(pluginCtx);
    } catch (err) {
      if (err instanceof PluginRejectionError) throw err;
      throw err;
    }

    let response: ImageResponse;
    try {
      response = await this.generateImage(ctx, req);
    } catch (err) {
      pluginCtx.error = err instanceof Error ? err : new Error(String(err));
      await this.pluginManager.runOnError(pluginCtx);
      throw err;
    }

    pluginCtx.metadata["_imageResponse"] = response;
    await this.pluginManager.runAfter(pluginCtx);
    return response;
  }

  /** Embedding request — find provider and call embed(). */
  async embed(
    ctx: RequestContext,
    req: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    const model = this.aliases[req.model] ?? req.model;
    const provider = this.registry.findByModel(model);
    if (!provider) {
      throw new Error(`No provider found for embedding model "${model}"`);
    }
    if (!("embed" in provider)) {
      throw new Error(`Provider "${provider.name}" does not support embeddings`);
    }
    return (provider as IEmbeddingProvider).embed(ctx, { ...req, model });
  }

  /** Image generation request — find provider and call generateImage(). */
  async generateImage(
    ctx: RequestContext,
    req: ImageRequest,
  ): Promise<ImageResponse> {
    const model = this.aliases[req.model] ?? req.model;
    const provider = this.registry.findByModel(model);
    if (!provider) {
      throw new Error(`No provider found for image model "${model}"`);
    }
    if (!("generateImage" in provider)) {
      throw new Error(`Provider "${provider.name}" does not support image generation`);
    }
    return (provider as IImageProvider).generateImage(ctx, { ...req, model });
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

  reloadConfig(config: GatewayConfig): void {
    this.config = config;
    this.aliases = config.aliases ?? {};

    this.registry = new ProviderRegistry();
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
      this.guardProvider(name, this.limitProvider(name, this.registry.get(name))),
    );
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
      if (breaker && !breaker.allow()) throw new CircuitOpenError(name);
      return breaker;
    };
    const fail = (breaker: ReturnType<typeof enter>, err: unknown) => {
      if (isAbortError(err) || err instanceof ConcurrencyLimitError) return;
      breaker?.recordFailure();
    };

    const guarded = {
      ...provider,
      complete: async (
        ctx: RequestContext,
        req: ChatCompletionRequest,
      ): Promise<ChatCompletionResponse> => {
        const breaker = enter();
        try {
          const res = await provider.complete(ctx, req);
          breaker?.recordSuccess();
          return res;
        } catch (err) {
          fail(breaker, err);
          throw err;
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
        const breaker = enter();
        let started = false;
        let settled = false;
        try {
          for await (const chunk of streamer.completeStream(ctx, req)) {
            started = true;
            yield chunk;
          }
          settled = true;
          breaker?.recordSuccess();
        } catch (err) {
          settled = true;
          fail(breaker, err);
          throw err;
        } finally {
          // Consumer stopped early: upstream had produced output, so it is healthy.
          if (!settled && started) breaker?.recordSuccess();
        }
      };
    }

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

function isAbortError(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}
