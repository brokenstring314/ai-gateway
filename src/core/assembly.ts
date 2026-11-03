/**
 * Gateway assembly (refactor plan §1.2): config → providers, plugins,
 * strategy, breakers, limiters, executor and pipeline. The Gateway facade
 * (src/gateway.ts) owns the result; nothing here runs a request.
 */

import { DEFAULT_MAX_OUTPUT_TOKENS, type GatewayConfig, type RetryConfig } from "../config/types.js";
import { assertConfigReferences } from "../config/validate.js";
import type { McpExecutor } from "../mcp/executor.js";
import { getMetrics } from "../metrics/metrics.js";
import { stableKey } from "../config/stable-key.js";
import {
  buildPluginsFromConfig,
  normalizePluginName,
  type PluginRegistration,
} from "../plugins/builtins/from-config.js";
import { RateLimitPluginConfigSchema } from "../plugins/builtins/config-schemas.js";
import type { KeyMeter } from "../usage/key-meter.js";
import { PluginManager } from "../plugins/manager.js";
import { ProviderRegistry } from "../providers/registry.js";
import { CircuitBreaker, CircuitBreakerRegistry } from "../routing/circuit-breaker.js";
import { ConcurrencyLimiter, ConcurrencyLimiterRegistry } from "../routing/concurrency-limiter.js";
import { createStrategy } from "../routing/strategy-factory.js";
import { ModelCatalog } from "../routing/model-catalog.js";
import type { IStrategy } from "../routing/types.js";
import { toGatewayError } from "./errors.js";
import { TargetExecutor } from "./executor.js";
import { mcpLoop } from "./mcp-loop.js";
import { Pipeline, type RequestLogSink } from "./pipeline.js";
import { createProviderFromTarget, targetKeyEntries } from "./provider-presets.js";
import { TargetLoad } from "../routing/balancer.js";
import { type KeyPool, KeyStateRegistry } from "../routing/key-pool.js";
import type { PublicHostGuard } from "../security/url-guard.js";
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
  /** Published models: the only names served (routing/model-catalog.ts). */
  readonly catalog: ModelCatalog;
  /**
   * Stateful pieces keyed by the config that built them, so a reload
   * (Gateway.reload) can carry them into the next snapshot when that config
   * is unchanged: breaker state, in-flight limiter slots, rate-limit windows.
   */
  readonly carry: CarryState;
  /** Key-state ids of every configured upstream key (KeyStateRegistry.retain after a reload). */
  readonly keyStateIds: ReadonlySet<string>;
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

export { stableKey } from "../config/stable-key.js";

export interface AssemblyHooks {
  /** The MCP tool executor at request time (null: no MCP loop). */
  readonly mcpExecutor: () => McpExecutor | null;
  /** Request-log sinks at request time. */
  readonly logSinks: () => Iterable<RequestLogSink>;
  /** Upstream key health across reloads (default: a fresh registry). */
  readonly keyState?: KeyStateRegistry;
  /** Requests in flight per target across reloads (least_inflight). */
  readonly load?: TargetLoad;
  /** SSRF guard for publicNetworkOnly targets (default: the shared one). */
  readonly guard?: PublicHostGuard;
  /** Per-key quota / RPM / TPM counters, kept across reloads (owned by the Gateway). */
  readonly keyMeter?: KeyMeter;
}

/** The rate-limit plugin's maxTokensPerMinute (the TPM of keys without their own), if configured. */
export function globalTokensPerMinute(config: Pick<GatewayConfig, "plugins">): number | undefined {
  for (const entry of config.plugins ?? []) {
    if (entry.enabled === false || normalizePluginName(entry.name) !== "rate-limit") continue;
    const parsed = RateLimitPluginConfigSchema.safeParse(entry.config ?? {});
    if (parsed.success && parsed.data.maxTokensPerMinute !== undefined) return parsed.data.maxTokensPerMinute;
  }
  return undefined;
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
  const seen = new Map<string, number>();
  for (const entry of config.plugins ?? []) {
    const base = stableKey({ entry });
    // Two identical entries stay two instances: the n-th occurrence gets its own key.
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = `${base}#${n}`;
    const regs = previous?.carry.plugins.get(key) ?? buildPluginsFromConfig([entry]);
    carriedPlugins.set(key, regs);
    for (const { stage, plugin } of regs) plugins.register(stage, plugin);
  }

  const circuitBreakers = new CircuitBreakerRegistry();
  const concurrencyLimiters = new ConcurrencyLimiterRegistry();
  const carriedBreakers = new Map<string, readonly [string, CircuitBreaker]>();
  const carriedLimiters = new Map<string, readonly [string, ConcurrencyLimiter]>();
  // Per-target retry, honored for every strategy (a target without one gets a single attempt).
  const retryConfigs = new Map<string, RetryConfig>();
  const keyState = hooks.keyState ?? new KeyStateRegistry();
  const load = hooks.load ?? new TargetLoad();
  const keyStateIds = new Set<string>();
  const pools = new Map<string, KeyPool>();
  for (const target of config.targets) {
    // A disabled target is not registered: no traffic, bindings to it are skipped.
    if (target.enabled === false) continue;
    const provider = createProviderFromTarget(target, config.compatibility?.onUnsupportedParam, {
      keyState,
      ...(hooks.guard ? { guard: hooks.guard } : {}),
    });
    registry.register(provider);
    if (provider.keyPool) pools.set(target.name, provider.keyPool);
    for (const k of targetKeyEntries(target)) {
      keyStateIds.add(
        KeyStateRegistry.stateId(target.name, { id: k.id, key: "", weight: k.weight, revision: k.revision }),
      );
    }
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
    unavailable: (name) => {
      const pool = pools.get(name);
      if (!pool || pool.available()) return undefined;
      try {
        pool.acquire();
        return undefined;
      } catch (err) {
        return err;
      }
    },
    load,
  });

  const targets = new Map(config.targets.map((t) => [t.name, t]));
  const globalTpm = globalTokensPerMinute(config);
  const catalog = new ModelCatalog(config, strategy, registry, load);
  const pipeline = new Pipeline({
    plugins,
    strategy,
    executor,
    lookup: (name) => registry.get(name),
    catalog,
    aliases: config.aliases ?? {},
    strategyLabel: config.strategy.mode,
    targetConfig: (name) => targets.get(name),
    mcp: () => {
      const mcp = hooks.mcpExecutor();
      return mcp ? mcpLoop(mcp) : null;
    },
    logSinks: hooks.logSinks,
    ...(hooks.keyMeter ? { keyMeter: hooks.keyMeter } : {}),
    ...(globalTpm !== undefined ? { globalTpm } : {}),
    maxOutputTokens: config.limits?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  });

  return {
    registry,
    plugins,
    strategy,
    circuitBreakers,
    concurrencyLimiters,
    executor,
    pipeline,
    catalog,
    carry: { breakers: carriedBreakers, limiters: carriedLimiters, plugins: carriedPlugins },
    keyStateIds,
  };
}

/** Current state of every configured circuit breaker, by target name. */
export function breakerStates(breakers: CircuitBreakerRegistry): Readonly<Record<string, string>> {
  const states: Record<string, string> = {};
  for (const [name, breaker] of breakers.all()) states[name] = breaker.getState();
  return states;
}
