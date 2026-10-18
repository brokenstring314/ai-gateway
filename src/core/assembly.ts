/**
 * Gateway assembly (refactor plan §1.2): config → providers, plugins,
 * strategy, breakers, limiters, executor and pipeline. The Gateway facade
 * (src/gateway.ts) owns the result; nothing here runs a request.
 */

import type { GatewayConfig, RetryConfig } from "../config/types.js";
import { assertConfigReferences } from "../config/validate.js";
import type { McpExecutor } from "../mcp/executor.js";
import { getMetrics } from "../metrics/metrics.js";
import { buildPluginsFromConfig } from "../plugins/builtins/from-config.js";
import { PluginManager } from "../plugins/manager.js";
import { ProviderRegistry } from "../providers/registry.js";
import { type CircuitBreaker, CircuitBreakerRegistry } from "../routing/circuit-breaker.js";
import { ConcurrencyLimiterRegistry } from "../routing/concurrency-limiter.js";
import { createStrategy } from "../routing/strategy-factory.js";
import type { IStrategy } from "../routing/types.js";
import { toGatewayError } from "./errors.js";
import { TargetExecutor } from "./executor.js";
import { mcpLoop } from "./mcp-loop.js";
import { Pipeline, type RequestLogSink } from "./pipeline.js";
import { createProviderFromTarget } from "./provider-presets.js";
import { buildStrategyConfig } from "./strategy-config.js";

export interface GatewayParts {
  readonly registry: ProviderRegistry;
  readonly plugins: PluginManager;
  readonly strategy: IStrategy;
  readonly circuitBreakers: CircuitBreakerRegistry;
  readonly concurrencyLimiters: ConcurrencyLimiterRegistry;
  /** Runs strategy-ordered candidates: breaker, limiter, retry, failover (core/executor.ts). */
  readonly executor: TargetExecutor;
  /** The request pipeline (core/pipeline.ts): plugins, executor, MCP loop, finalize. */
  readonly pipeline: Pipeline;
}

export interface AssemblyHooks {
  /** The MCP tool executor at request time (null: no MCP loop). */
  readonly mcpExecutor: () => McpExecutor | null;
  /** Request-log sinks at request time. */
  readonly logSinks: () => Iterable<RequestLogSink>;
}

export function assembleGateway(config: GatewayConfig, hooks: AssemblyHooks): GatewayParts {
  // Embedded configs skip the schema: same cross-reference checks as validate/startup.
  assertConfigReferences(config);
  const registry = new ProviderRegistry();
  const plugins = new PluginManager();
  for (const { stage, plugin } of buildPluginsFromConfig(config.plugins, config.targets)) {
    plugins.register(stage, plugin);
  }

  const circuitBreakers = new CircuitBreakerRegistry();
  const concurrencyLimiters = new ConcurrencyLimiterRegistry();
  // Per-target retry, honored for every strategy (a target without one gets a single attempt).
  const retryConfigs = new Map<string, RetryConfig>();
  for (const target of config.targets) {
    registry.register(createProviderFromTarget(target, config.compatibility?.onUnsupportedParam));
    if (target.circuitBreaker) circuitBreakers.getOrCreate(target.name, target.circuitBreaker);
    if (target.concurrency?.maxConcurrency) {
      concurrencyLimiters.getOrCreate(target.name, {
        maxConcurrency: target.concurrency.maxConcurrency,
        queueSize: target.concurrency.queueSize,
      });
    }
    if (target.retry) retryConfigs.set(target.name, target.retry);
  }

  const { mode, config: strategyConfig } = buildStrategyConfig(config);
  const strategy = createStrategy(mode, strategyConfig);
  const metrics = getMetrics();
  for (const [name, breaker] of circuitBreakers.all()) metrics.setCircuitBreakerState(name, breaker.getState());
  const executor = new TargetExecutor({
    lookup: (name) => registry.get(name),
    breaker: (name) => circuitBreakers.get(name),
    limiter: (name) => concurrencyLimiters.get(name),
    retryConfig: (name) => retryConfigs.get(name),
    onAttemptFailure: (name, err) => metrics.recordProviderError(name, toGatewayError(err).kind),
    onBreakerSettled: (name, breaker: CircuitBreaker) => metrics.setCircuitBreakerState(name, breaker.getState()),
  });

  const targets = new Map(config.targets.map((t) => [t.name, t]));
  const pipeline = new Pipeline({
    plugins,
    strategy,
    executor,
    lookup: (name) => registry.get(name),
    findByModel: (model) => registry.findByModel(model),
    aliases: config.aliases ?? {},
    strategyLabel: config.strategy.mode,
    targetConfig: (name) => targets.get(name),
    mcp: () => {
      const mcp = hooks.mcpExecutor();
      return mcp ? mcpLoop(mcp) : null;
    },
    logSinks: hooks.logSinks,
  });

  return { registry, plugins, strategy, circuitBreakers, concurrencyLimiters, executor, pipeline };
}

/** Current state of every configured circuit breaker, by target name. */
export function breakerStates(breakers: CircuitBreakerRegistry): Readonly<Record<string, string>> {
  const states: Record<string, string> = {};
  for (const [name, breaker] of breakers.all()) states[name] = breaker.getState();
  return states;
}
