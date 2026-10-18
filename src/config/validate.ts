/**
 * Cross-reference checks on a parsed config (B3-11), shared by the schema
 * (so `ai-gateway validate` and bootstrap() report them as validation
 * errors) and by the embedded `new Gateway(config)`, which skips the schema.
 */

import { baseURLProblem } from "../core/provider-presets.js";
import { piiSecretGuardConfigIssues } from "../plugins/builtins/pii-secret-guard/config.js";
import type { GatewayConfig } from "./types.js";

export interface ConfigIssue {
  path: (string | number)[];
  message: string;
}

type CheckedConfig = Pick<GatewayConfig, "targets" | "strategy"> & Partial<Pick<GatewayConfig, "plugins">>;

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

  // pii-secret-guard has a strict config schema of its own.
  (cfg.plugins ?? []).forEach((p, i) => {
    if (p.enabled === false || p.name.trim().toLowerCase().replace(/_/g, "-") !== "pii-secret-guard") return;
    for (const issue of piiSecretGuardConfigIssues(p.config ?? {})) {
      issues.push({ path: ["plugins", i, "config", ...issue.path], message: `pii-secret-guard: ${issue.message}` });
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
