/**
 * Cross-reference checks on a parsed config (B3-11), shared by the schema
 * (so `ai-gateway validate` and bootstrap() report them as validation
 * errors) and by the embedded `new Gateway(config)`, which skips the schema.
 */

import { knownUpstreamModel } from "../core/model-presets.js";
import { baseURLProblem } from "../core/provider-presets.js";
import { builtinPluginConfigIssues } from "../plugins/builtins/config-schemas.js";
import { piiSecretGuardConfigIssues } from "../plugins/builtins/pii-secret-guard/config.js";
import type { GatewayConfig } from "./types.js";

export interface ConfigIssue {
  path: (string | number)[];
  message: string;
}

type CheckedConfig = Pick<GatewayConfig, "targets" | "strategy"> &
  Partial<Pick<GatewayConfig, "plugins" | "models" | "aliases">>;

function positive(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Every cross-reference problem in a config; empty when it is consistent. */
export function configReferenceIssues(cfg: CheckedConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const targets = cfg.targets ?? [];
  const names = new Set<string>();

  targets.forEach((t, i) => {
    if (names.has(t.name)) {
      issues.push({
        path: ["targets", i, "name"],
        message: `duplicate target name "${t.name}"; target names must be unique`,
      });
    }
    names.add(t.name);
    const problem = baseURLProblem(t);
    if (problem !== undefined) issues.push({ path: ["targets", i, "baseURL"], message: problem });
  });

  // Every built-in plugin has a strict config schema (unknown keys, wrong
  // types and missing required settings are errors).
  (cfg.plugins ?? []).forEach((p, i) => {
    if (p.enabled === false) return;
    const name = p.name.trim().toLowerCase().replace(/_/g, "-");
    const found =
      name === "pii-secret-guard"
        ? piiSecretGuardConfigIssues(p.config ?? {})
        : builtinPluginConfigIssues(name, p.config ?? {});
    for (const issue of found) {
      issues.push({ path: ["plugins", i, "config", ...issue.path], message: `${name}: ${issue.message}` });
    }
  });

  // A budget without any cost rate charges $0 per request and never enforces (C3-5).
  (cfg.plugins ?? []).forEach((p, i) => {
    if (p.enabled === false || p.name.trim().toLowerCase().replace(/_/g, "-") !== "budget") return;
    const raw = (p.config ?? {}) as Record<string, unknown>;
    if (positive(raw["costPer1kInput"]) || positive(raw["costPer1kOutput"])) return;
    const unpriced = targets.filter((t) => !positive(t.costPer1kInputTokens) && !positive(t.costPer1kOutputTokens));
    if (targets.length > 0 && unpriced.length === 0) return;
    issues.push({
      path: ["plugins", i, "config"],
      message:
        "budget plugin has no cost rates: set config.costPer1kInput / costPer1kOutput, or costPer1kInputTokens / " +
        `costPer1kOutputTokens on every target (unpriced: ${unpriced.map((t) => t.name).join(", ")}); ` +
        "without rates every request costs $0 and the budget never enforces",
    });
  });

  const known = () => [...names].join(", ");
  issues.push(...modelIssues(cfg, names, known));
  const sc = cfg.strategy;
  if (sc === undefined) return issues;

  (sc.targets ?? []).forEach((name, i) => {
    if (!names.has(name)) {
      issues.push({
        path: ["strategy", "targets", i],
        message: `strategy.targets references unknown target "${name}" (targets: ${known()})`,
      });
    }
  });
  for (const name of Object.keys(sc.weights ?? {})) {
    if (!names.has(name)) {
      issues.push({
        path: ["strategy", "weights", name],
        message: `strategy.weights references unknown target "${name}" (targets: ${known()})`,
      });
    }
  }
  (sc.rules ?? []).forEach((rule, i) => {
    if (!names.has(rule.target)) {
      issues.push({
        path: ["strategy", "rules", i, "target"],
        message: `strategy.rules[${i}].target references unknown target "${rule.target}" (targets: ${known()})`,
      });
    }
  });

  if (sc.mode === "loadbalance") {
    const pool = sc.targets ?? targets.map((t) => t.name);
    const weightOf = (name: string) => targets.find((t) => t.name === name)?.weight ?? sc.weights?.[name] ?? 1;
    if (pool.length > 0 && pool.every((name) => weightOf(name) === 0)) {
      issues.push({
        path: ["strategy", "weights"],
        message: "loadbalance: every target has weight 0 (0 = drained); at least one weight must be > 0",
      });
    }
  }
  return issues;
}

/** Published models: unique names, known targets, one binding per target, a usable loadbalance pool, aliases. */
function modelIssues(cfg: CheckedConfig, targetNames: ReadonlySet<string>, known: () => string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const models = cfg.models;
  const aliases = cfg.aliases ?? {};
  if (models !== undefined) {
    const seen = new Set<string>();
    models.forEach((m, i) => {
      if (seen.has(m.name)) {
        issues.push({ path: ["models", i, "name"], message: `duplicate model name "${m.name}"` });
      }
      seen.add(m.name);
      if (aliases[m.name] !== undefined) {
        issues.push({
          path: ["models", i, "name"],
          message: `model name "${m.name}" is also an alias key; rename one of them`,
        });
      }
      const bound = new Set<string>();
      m.bindings.forEach((b, j) => {
        if (!targetNames.has(b.target)) {
          issues.push({
            path: ["models", i, "bindings", j, "target"],
            message: `model "${m.name}" binds unknown target "${b.target}" (targets: ${known()})`,
          });
        }
        if (bound.has(b.target)) {
          issues.push({
            path: ["models", i, "bindings", j, "target"],
            message: `model "${m.name}" binds target "${b.target}" twice; one binding per target`,
          });
        }
        bound.add(b.target);
      });
      issues.push(...upstreamLimitIssues(cfg, m, i));
      if (m.strategy === "loadbalance" && m.bindings.every((b) => (b.weight ?? 1) === 0)) {
        issues.push({
          path: ["models", i, "bindings"],
          message: `model "${m.name}": every binding has weight 0 (0 = drained); at least one must be > 0`,
        });
      }
    });
    for (const [alias, target] of Object.entries(aliases)) {
      if (!seen.has(target)) {
        issues.push({
          path: ["aliases", alias],
          message: `alias "${alias}" points to "${target}", which is not a published model (models[].name)`,
        });
      }
    }
  }
  return issues;
}

const STRUCTURED_RANK = { none: 0, json_object: 1, json_schema: 2 } as const;

/**
 * A published model must not promise more than a bound upstream that is
 * known to support less (core/model-presets.ts): the gateway's limits are
 * what downstream callers rely on, so they must fit inside every upstream.
 */
function upstreamLimitIssues(
  cfg: CheckedConfig,
  m: NonNullable<CheckedConfig["models"]>[number],
  i: number,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const meta = m.metadata;
  if (!meta) return issues;
  const providerOf = new Map((cfg.targets ?? []).map((t) => [t.name, t.provider]));
  for (const b of m.bindings) {
    const provider = providerOf.get(b.target);
    if (provider === undefined) continue;
    const upstream = b.model ?? m.name;
    const known = knownUpstreamModel(provider, upstream);
    if (!known) continue;
    const where = `upstream "${upstream}" on target "${b.target}"`;
    const at = (field: string): (string | number)[] => ["models", i, "metadata", field];
    if (meta.contextWindow !== undefined && meta.contextWindow > known.contextWindow) {
      issues.push({
        path: at("contextWindow"),
        message: `model "${m.name}": contextWindow ${meta.contextWindow} exceeds ${where} (${known.contextWindow})`,
      });
    }
    if (meta.maxOutputTokens !== undefined && meta.maxOutputTokens > known.maxOutputTokens) {
      issues.push({
        path: at("maxOutputTokens"),
        message: `model "${m.name}": maxOutputTokens ${meta.maxOutputTokens} exceeds ${where} (${known.maxOutputTokens})`,
      });
    }
    const missing = (meta.inputModalities ?? []).filter((x) => !known.inputModalities.includes(x));
    if (missing.length > 0) {
      issues.push({
        path: at("inputModalities"),
        message: `model "${m.name}": ${where} does not accept ${missing.join(", ")} input`,
      });
    }
    if (meta.tools === true && known.tools === false) {
      issues.push({ path: at("tools"), message: `model "${m.name}": ${where} does not support tool calls` });
    }
    if (
      meta.structuredOutput !== undefined &&
      known.structuredOutput !== undefined &&
      STRUCTURED_RANK[meta.structuredOutput] > STRUCTURED_RANK[known.structuredOutput]
    ) {
      issues.push({
        path: at("structuredOutput"),
        message: `model "${m.name}": ${where} supports structured output up to "${known.structuredOutput}"`,
      });
    }
  }
  return issues;
}

/** Throws one Error listing every cross-reference problem (embedded Gateway). */
export function assertConfigReferences(cfg: CheckedConfig): void {
  const issues = configReferenceIssues(cfg);
  if (issues.length === 0) return;
  throw new Error(
    `Invalid config:\n${issues.map((i) => `  ✖ ${i.message}\n    → at ${formatPath(i.path)}`).join("\n")}`,
  );
}

function formatPath(path: (string | number)[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`)).join("");
}
