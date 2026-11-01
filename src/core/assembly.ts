/**
 * Gateway assembly (refactor plan §1.2): config → providers, plugins,
 * strategy, breakers, limiters, executor and pipeline. The Gateway facade
 * (src/gateway.ts) owns the result; nothing here runs a request.
 */

import type { GatewayConfig, RetryConfig } from "../config/types.js";
import { assertConfigReferences } from "../config/validate.js";
import type { McpExecutor } from "../mcp/executor.js";
import { getMetrics } from "../metrics/metrics.js";
import {
  buildPluginsFromConfig,
  normalizePluginName,
  type PluginRegistration,
} from "../plugins/builtins/from-config.js";
import { PluginManager } from "../plugins/manager.js";
import { ProviderRegistry } from "../providers/registry.js";
import { CircuitBreaker, CircuitBreakerRegistry } from "../routing/circuit-breaker.js";
import { ConcurrencyLimiter, ConcurrencyLimiterRegistry } from "../routing/concurrency-limiter.js";
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
  /**
   * Stateful pieces keyed by the config that built them, so a reload
   * (Gateway.reload) can carry them into the next snapshot when that config
   * is unchanged: breaker state, in-flight limiter slots, rate-limit windows.
   */
  readonly carry: CarryState;
}

/** Stateful parts a reload reuses when the config that built them is unchanged. */
export interface CarryState {
  /** target name → [config key, breaker]. */
  readonly breakers: ReadonlyMap<string, readonly [string, CircuitBreaker]>;
  /** target name → [config key, limiter]. */
  readonly limiters: ReadonlyMap<string, readonly [string, ConcurrencyLimiter]>;
  /** plugin entry key → its registrations, in order. */
  readonly plugins: ReadonlyMap<string, readonly PluginRegistration[]>;
}

/** Deterministic JSON (sorted object keys) used as a config identity key. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

export interface AssemblyHooks {
  /** The MCP tool executor at request time (null: no MCP loop). */
  readonly mcpExecutor: () => McpExecutor | null;
  /** Request-log sinks at request time. */
  readonly logSinks: () => Iterable<RequestLogSink>;
}

/**
 * Build every runtime part from `config`. With `previous` (a reload), the
 * stateful parts whose config is unchanged are carried over instead of
 * rebuilt (see CarryState); everything else is new. Throws on an invalid
 * config before anything is shared with `previous`.
 */
export function assembleGateway(config: GatewayConfig, hooks: AssemblyHooks, previous?: GatewayParts): GatewayParts {
  // Embedded configs skip the schema: same cross-reference checks as validate/startup.
  assertConfigReferences(config);
  const registry = new ProviderRegistry();
  const plugins = new PluginManager();
  const carriedPlugins = new Map<string, readonly PluginRegistration[]>();
  // Budget reservation rates depend on the targets' prices, so they are part of its key.
  const rates = config.targets.map((t) => [t.costPer1kInputTokens ?? 0, t.costPer1kOutputTokens ?? 0]);
  const seen = new Map<string, number>();
  for (const entry of config.plugins ?? []) {
    const base = stableKey({ entry, rates: normalizePluginName(entry.name) === "budget" ? rates : null });
    // Two identical entries stay two instances: the n-th occurrence gets its own key.
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = `${base}#${n}`;
    const regs = previous?.carry.plugins.get(key) ?? buildPluginsFromConfig([entry], config.targets);
    carriedPlugins.set(key, regs);
    for (const { stage, plugin } of regs) plugins.register(stage, plugin);
  }

  const circuitBreakers = new CircuitBreakerRegistry();
  const concurrencyLimiters = new ConcurrencyLimiterRegistry();
  const carriedBreakers = new Map<string, readonly [string, CircuitBreaker]>();
  const carriedLimiters = new Map<string, readonly [string, ConcurrencyLimiter]>();
  // Per-target retry, honored for every strategy (a target without one gets a single attempt).
  const retryConfigs = new Map<string, RetryConfig>();
  for (const target of config.targets) {
    registry.register(createProviderFromTarget(target, config.compatibility?.onUnsupportedParam));
    if (target.circuitBreaker) {
      const key = stableKey(target.circuitBreaker);
      const prev = previous?.carry.breakers.get(target.name);
      const breaker = prev && prev[0] === key ? prev[1] : new CircuitBreaker(target.name, target.circuitBreaker);
      circuitBreakers.adopt(target.name, breaker);
      carriedBreakers.set(target.name, [key, breaker]);
    }
    if (target.concurrency?.maxConcurrency) {
      const options = { maxConcurrency: target.concurrency.maxConcurrency, queueSize: target.concurrency.queueSize };
      const key = stableKey(options);
      const prev = previous?.carry.limiters.get(target.name);
      // A changed limit gets a fresh limiter; requests already holding a slot
      // release it into the old one, so the two limits overlap briefly.
      const limiter = prev && prev[0] === key ? prev[1] : new ConcurrencyLimiter(options);
      concurrencyLimiters.adopt(target.name, limiter);
      carriedLimiters.set(target.name, [key, limiter]);
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

  return {
    registry,
    plugins,
    strategy,
    circuitBreakers,
    concurrencyLimiters,
    executor,
    pipeline,
    carry: { breakers: carriedBreakers, limiters: carriedLimiters, plugins: carriedPlugins },
  };
}

/** Current state of every configured circuit breaker, by target name. */
export function breakerStates(breakers: CircuitBreakerRegistry): Readonly<Record<string, string>> {
  const states: Record<string, string> = {};
  for (const [name, breaker] of breakers.all()) states[name] = breaker.getState();
  return states;
}
