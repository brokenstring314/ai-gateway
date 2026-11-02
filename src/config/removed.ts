/**
 * Config keys and values removed or deprecated (0.2.0, 0.3.0), with migration hints.
 *
 * Removed items fail validation (both `ai-gateway validate` and startup) with
 * a message that says what to write instead. Deprecated aliases still work
 * for one release and produce a warning.
 */

/** Removed strategy modes (snake and hyphen forms) → migration hint. */
export const REMOVED_STRATEGY_MODES: Readonly<Record<string, string>> = {
  least_latency:
    "strategy mode least_latency was removed in 0.2.0; use fallback (list strategy.targets in order of preference)",
  cost_optimized:
    "strategy mode cost_optimized was removed in 0.2.0; use fallback with strategy.targets in order of preference",
  content_based:
    "strategy mode content_based was removed in 0.2.0; use conditional with rules like " +
    "{ field: prompt, contains: <keyword>, target: <name> } (or pattern: <regex>)",
};

const MODE_SPELLINGS: Readonly<Record<string, string>> = {
  "least-latency": "least_latency",
  "cost-optimized": "cost_optimized",
  "content-based": "content_based",
  "ab-test": "abtest",
};

/** Deprecated strategy modes that still work as aliases (removed in 0.3.0). */
export const DEPRECATED_STRATEGY_MODES: Readonly<Record<string, "loadbalance">> = {
  abtest: "loadbalance",
};

/** Canonical spelling of a strategy mode string (hyphen → snake). */
export function canonicalStrategyMode(mode: string): string {
  return MODE_SPELLINGS[mode] ?? mode;
}

/** Removed strategy keys (canonical camelCase and Go snake_case) → migration hint. */
export const REMOVED_STRATEGY_KEYS: Readonly<Record<string, string>> = {
  conditions:
    "strategy.conditions (Go key/value/target_key) was removed in 0.2.0; use strategy.rules: [{ field, pattern, target }]",
  contentConditions:
    "strategy.contentConditions was removed in 0.2.0; use strategy.rules with field: prompt and contains/pattern (mode: conditional)",
  content_conditions:
    "strategy.content_conditions was removed in 0.2.0; use strategy.rules with field: prompt and contains/pattern (mode: conditional)",
  keywords:
    "strategy.keywords was removed in 0.2.0; use strategy.rules: [{ field: prompt, contains: <keyword>, target: <name> }] (mode: conditional)",
  abVariants:
    "strategy.abVariants was removed in 0.2.0; use mode: loadbalance with strategy.weights: { <target>: <weight> }",
  ab_variants:
    "strategy.ab_variants was removed in 0.2.0; use mode: loadbalance with strategy.weights: { <target>: <weight> }",
  unpricedStrategy:
    "strategy.unpricedStrategy was removed in 0.2.0 together with cost_optimized; use fallback with strategy.targets in order of preference",
  unpriced_strategy:
    "strategy.unpriced_strategy was removed in 0.2.0 together with cost_optimized; use fallback with strategy.targets in order of preference",
};

/** Removed observability keys → migration hint. */
export const REMOVED_OBSERVABILITY_KEYS: Readonly<Record<string, string>> = {
  exporters:
    "observability.exporters was removed in 0.2.0 (no exporter was ever implemented); " +
    "use observability.tracing (OTLP: enabled, otlpEndpoint, headers)",
};

function COST_REMOVED(key: string): string {
  return (
    `targets[].${key} was removed in 0.3.0: the gateway no longer prices requests (no costs, prices or money ` +
    "quotas). Delete the key; usage is reported in tokens (GET /admin/usage) and client keys are limited by " +
    "token quota, RPM and TPM"
  );
}

/** Target keys that were accepted but never read by any strategy or plugin → migration hint. */
export const REMOVED_TARGET_KEYS: Readonly<Record<string, string>> = {
  priority:
    "targets[].priority is not supported (it was accepted but never read by any strategy); " +
    "to prefer targets in order use mode: fallback and list strategy.targets in order of preference",
  budget:
    "targets[].budget is not supported (it was accepted but never enforced). The gateway has no money-based limits " +
    'since 0.3.0: limit a client key by tokens instead (Admin API PATCH /admin/keys/:id {"quotaTokens": N} or ' +
    "ai-gateway keys create --quota-tokens N)",
  costPer1kInputTokens: COST_REMOVED("costPer1kInputTokens"),
  costPer1kOutputTokens: COST_REMOVED("costPer1kOutputTokens"),
};

/** Removed built-in plugins (normalized kebab-case name) → migration hint. Enabled entries fail validation. */
export const REMOVED_PLUGINS: Readonly<Record<string, string>> = {
  budget:
    "the budget plugin was removed in 0.3.0: the gateway no longer prices requests or enforces money budgets. " +
    "Remove it from plugins and limit client keys by tokens instead: a token quota per key " +
    '(PATCH /admin/keys/:id {"quotaTokens": N} or ai-gateway keys create --quota-tokens N), plus rpm / tpm',
};

/** Message for observability.tracing.otlpProtocol: grpc (only OTLP/HTTP is implemented). */
export const OTLP_GRPC_UNSUPPORTED =
  "otlpProtocol grpc is not supported: only the OTLP/HTTP exporter is implemented. " +
  "Remove otlpProtocol (or set it to http) and point otlpEndpoint at the collector's OTLP/HTTP traces URL, " +
  'usually port 4318, e.g. "http://localhost:4318/v1/traces"';

/** Non-fatal warnings for a raw (pre-validation) config object. */
export function configDeprecationWarnings(raw: unknown): string[] {
  const warnings: string[] = [];
  if (typeof raw !== "object" || raw === null) return warnings;
  const strategy = (raw as { strategy?: unknown }).strategy;
  if (typeof strategy === "object" && strategy !== null) {
    const mode = (strategy as { mode?: unknown }).mode;
    if (typeof mode === "string") {
      const canonical = canonicalStrategyMode(mode);
      const alias = DEPRECATED_STRATEGY_MODES[canonical];
      if (alias !== undefined) {
        warnings.push(
          `strategy mode ${mode} is deprecated since 0.2.0 and runs as ${alias} (weighted random); ` +
            `set mode: ${alias}. The alias will be removed in 0.3.0.`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Resolve a strategy mode for code paths that skip schema validation
 * (embedded `new Gateway(config)`): applies the deprecated alias and throws
 * the migration hint for removed modes.
 */
export function resolveStrategyMode(mode: string): "single" | "fallback" | "loadbalance" | "conditional" {
  const canonical = canonicalStrategyMode(mode);
  const hint = REMOVED_STRATEGY_MODES[canonical];
  if (hint !== undefined) throw new Error(hint);
  const alias = DEPRECATED_STRATEGY_MODES[canonical];
  if (alias !== undefined) return alias;
  if (
    canonical === "single" ||
    canonical === "fallback" ||
    canonical === "loadbalance" ||
    canonical === "conditional"
  ) {
    return canonical;
  }
  throw new Error(`unknown strategy mode "${mode}"; expected one of single, fallback, loadbalance, conditional`);
}
