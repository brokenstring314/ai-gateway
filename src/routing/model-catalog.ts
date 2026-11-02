/**
 * Published models (0.3.0 P2, plan §3.5): which model names this gateway
 * serves and which targets serve each one.
 *
 * Two modes, fixed per config:
 *  - explicit (`config.models` set): each model has its own bindings and
 *    strategy (fallback by priority, or loadbalance by weight) and may rename
 *    the model per binding. The global `strategy` does not route.
 *  - implicit (`config.models` unset, the 0.2.0 shape): every model a
 *    provider declares (targets[].models, plus providers registered by an
 *    embedder; a custom provider's supportsModel() counts too) is published; requests for it follow the global strategy's
 *    order restricted to the targets that list it (then any other target
 *    that lists it), with the name unchanged.
 *
 * A name that is neither published nor an alias of a published name is
 * rejected (404 model_not_found): it never reaches an upstream.
 */

import type { GatewayConfig, ModelMetadata, PublishedModelConfig } from "../config/types.js";
import { knownUpstreamModel } from "../core/model-presets.js";
import type { ChatCompletionRequest, IProvider } from "../providers/types.js";
import { PriorityGroupStrategy, priorityGroups, TargetLoad } from "./balancer.js";
import type { IStrategy, StrategyMode } from "./types.js";

/** How a request for one published model is routed. */
export interface ModelRoute {
  /** Orders the candidate targets (only targets bound to the model). */
  readonly strategy: IStrategy;
  /** Model name to send to each target. */
  readonly upstreamModel: (target: string) => string;
  /** Extra upstream body fields for each target (binding params), if any. */
  readonly params: (target: string) => Readonly<Record<string, unknown>> | undefined;
}

export interface CatalogEntry {
  readonly name: string;
  readonly enabled: boolean;
  /**
   * False when no binding can serve it right now: every binding is disabled,
   * drained (weight 0) or bound to a disabled target. The model stays
   * published (aliases keep resolving) and requests get 503 model_unavailable.
   */
  readonly available: boolean;
  readonly displayName?: string;
  readonly description?: string;
  /**
   * Effective metadata: what was configured, with unset fields filled from
   * what every bound upstream is known to support (core/model-presets.ts).
   */
  readonly metadata?: ModelMetadata;
  /** Targets serving it (enabled bindings on enabled targets), in priority order. */
  readonly targets: readonly string[];
  readonly route: ModelRoute;
}

/** Global strategy order restricted to the bound targets, then the remaining bound targets. */
class RestrictedStrategy implements IStrategy {
  readonly mode: StrategyMode;
  constructor(
    private readonly inner: IStrategy,
    private readonly bound: readonly string[],
  ) {
    this.mode = inner.mode;
  }
  selectTargets(req: ChatCompletionRequest): readonly string[] {
    let ordered: readonly string[];
    try {
      ordered = this.inner.selectTargets(req);
    } catch {
      ordered = [];
    }
    const allowed = new Set(this.bound);
    const out = [...new Set(ordered)].filter((t) => allowed.has(t));
    for (const t of this.bound) if (!out.includes(t)) out.push(t);
    return out;
  }
}

const STRUCTURED_ORDER = ["none", "json_object", "json_schema"] as const;

/**
 * Metadata every listed upstream supports: smallest limits, common input
 * types, features all of them have. Undefined when any upstream is unknown.
 */
export function commonUpstreamMetadata(
  upstreams: ReadonlyArray<{ provider: string; model: string }>,
): ModelMetadata | undefined {
  if (upstreams.length === 0) return undefined;
  const known = upstreams.map((u) => knownUpstreamModel(u.provider, u.model));
  if (known.some((k) => k === undefined)) return undefined;
  const ks = known as NonNullable<(typeof known)[number]>[];
  const modalities = ks.map((k) => k.inputModalities).reduce((acc, list) => acc.filter((m) => list.includes(m)));
  const out: ModelMetadata = {
    contextWindow: Math.min(...ks.map((k) => k.contextWindow)),
    maxOutputTokens: Math.min(...ks.map((k) => k.maxOutputTokens)),
    inputModalities: [...modalities],
  };
  if (ks.every((k) => k.tools !== undefined)) out.tools = ks.every((k) => k.tools === true);
  if (ks.every((k) => k.structuredOutput !== undefined)) {
    out.structuredOutput = STRUCTURED_ORDER[Math.min(...ks.map((k) => STRUCTURED_ORDER.indexOf(k.structuredOutput!)))];
  }
  return out;
}

function mergeMetadata(
  configured: ModelMetadata | undefined,
  derived: ModelMetadata | undefined,
): ModelMetadata | undefined {
  if (!configured && !derived) return undefined;
  return { ...(derived ?? {}), ...(configured ?? {}) };
}

/**
 * Route of an explicit model: priority groups over its usable bindings
 * (routing/balancer.ts). `fallback` (default) groups by priority, which
 * defaults to list order; `loadbalance` puts every binding in one group.
 */
function explicitRoute(m: PublishedModelConfig, usable: (target: string) => boolean, load: TargetLoad): ModelRoute {
  const active = m.bindings.map((b, i) => ({ b, i })).filter(({ b }) => b.enabled !== false && usable(b.target));
  const byTarget = new Map(active.map(({ b }) => [b.target, b.model ?? m.name]));
  const paramsByTarget = new Map(active.filter(({ b }) => b.params).map(({ b }) => [b.target, b.params!]));
  const upstreamModel = (t: string) => byTarget.get(t) ?? m.name;
  const params = (t: string) => paramsByTarget.get(t);
  const members = active.map(({ b, i }) => ({
    name: b.target,
    weight: b.weight ?? 1,
    priority: m.strategy === "loadbalance" ? 0 : (b.priority ?? i),
  }));
  const mode: StrategyMode = m.strategy === "loadbalance" ? "loadbalance" : "fallback";
  const strategy = new PriorityGroupStrategy(priorityGroups(members), m.balance ?? "weighted", load, mode);
  return { strategy, upstreamModel, params };
}

const noParams = () => undefined;

/** Where implicit mode reads the declared models: the provider registry. */
export interface ProviderSource {
  readonly revision: number;
  all(): readonly IProvider[];
}

export class ModelCatalog {
  private entries: ReadonlyMap<string, CatalogEntry>;
  private readonly aliases: Readonly<Record<string, string>>;
  /** True when built from config.models (else derived from the providers' models). */
  readonly explicit: boolean;
  private seenRevision = -1;

  private readonly providerOf: ReadonlyMap<string, string>;

  constructor(
    config: Pick<GatewayConfig, "models" | "aliases" | "targets">,
    private readonly globalStrategy: IStrategy,
    private readonly providers: ProviderSource,
    load: TargetLoad = new TargetLoad(),
  ) {
    this.aliases = config.aliases ?? {};
    this.providerOf = new Map(config.targets.map((t) => [t.name, t.provider]));
    this.explicit = config.models !== undefined;
    const enabledTargets = new Set(config.targets.filter((t) => t.enabled !== false).map((t) => t.name));
    const entries = new Map<string, CatalogEntry>();
    if (config.models !== undefined) {
      for (const m of config.models) {
        const route = explicitRoute(m, (t) => enabledTargets.has(t), load);
        const targets = (route.strategy as PriorityGroupStrategy).members().flatMap((g) => g.map((x) => x.name));
        entries.set(m.name, {
          name: m.name,
          enabled: m.enabled !== false,
          available: targets.length > 0,
          ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
          ...(m.description !== undefined ? { description: m.description } : {}),
          ...optionalMetadata(
            mergeMetadata(
              m.metadata,
              commonUpstreamMetadata(
                m.bindings.map((b) => ({ provider: this.providerOf.get(b.target) ?? "", model: b.model ?? m.name })),
              ),
            ),
          ),
          targets,
          route,
        });
      }
    }
    this.entries = entries;
  }

  /** Implicit mode: re-derive when the provider registry changed (embedder registerProvider). */
  private current(): ReadonlyMap<string, CatalogEntry> {
    if (this.explicit || this.seenRevision === this.providers.revision) return this.entries;
    const bound = new Map<string, string[]>();
    for (const p of this.providers.all()) {
      for (const m of p.models()) {
        const list = bound.get(m.id) ?? [];
        if (!list.includes(p.name)) list.push(p.name);
        bound.set(m.id, list);
      }
    }
    const entries = new Map<string, CatalogEntry>();
    for (const [name, targets] of bound) {
      entries.set(name, this.implicitEntry(name, targets));
    }
    this.entries = entries;
    this.seenRevision = this.providers.revision;
    return entries;
  }

  /** The published model a requested name means (after aliases), enabled or not. */
  lookup(requested: string): CatalogEntry | undefined {
    const name = this.aliases[requested] ?? requested;
    const found = this.current().get(name);
    if (found || this.explicit || name === "") return found;
    // Implicit mode: a provider that answers supportsModel() for a name it
    // does not list (an embedder's custom provider) serves it too. Built per
    // request and never cached, so arbitrary names cannot grow memory.
    const targets = this.providers
      .all()
      .filter((p) => p.supportsModel(name))
      .map((p) => p.name);
    if (targets.length === 0) return undefined;
    return this.implicitEntry(name, targets);
  }

  private implicitEntry(name: string, targets: string[]): CatalogEntry {
    const derived = commonUpstreamMetadata(
      targets.map((t) => ({ provider: this.providerOf.get(t) ?? "", model: name })),
    );
    return {
      name,
      enabled: true,
      available: targets.length > 0,
      targets,
      ...optionalMetadata(derived),
      route: {
        strategy: new RestrictedStrategy(this.globalStrategy, targets),
        upstreamModel: () => name,
        params: noParams,
      },
    };
  }

  /** Every published model, in definition order. */
  list(): readonly CatalogEntry[] {
    return [...this.current().values()];
  }

  /** Alias name → published model name. */
  aliasMap(): Readonly<Record<string, string>> {
    return this.aliases;
  }

  /** Targets that serve no published model (implicit mode: no targets[].models list). */
  unusedTargets(targetNames: readonly string[]): string[] {
    const used = new Set(this.list().flatMap((e) => e.targets));
    return targetNames.filter((t) => !used.has(t));
  }
}

/** Whether a key restricted to `allowed` may use `requested` (or the model it aliases). */
export function modelAllowed(
  allowed: readonly string[] | undefined | null,
  requested: string,
  resolved: string,
): boolean {
  if (allowed === undefined || allowed === null) return true;
  return allowed.includes(requested) || allowed.includes(resolved);
}

function optionalMetadata(metadata: ModelMetadata | undefined): { metadata?: ModelMetadata } {
  return metadata !== undefined ? { metadata } : {};
}
