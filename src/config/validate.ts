/**
 * Cross-reference checks on a parsed config (B3-11), shared by the schema
 * (so `ai-gateway validate` and bootstrap() report them as validation
 * errors) and by the embedded `new Gateway(config)`, which skips the schema.
 */

import { baseURLProblem } from "../core/provider-presets.js";
import type { GatewayConfig } from "./types.js";

export interface ConfigIssue {
  path: (string | number)[];
  message: string;
}

type CheckedConfig = Pick<GatewayConfig, "targets" | "strategy">;

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
  throw new Error(`Invalid config:\n${issues.map((i) => `  ✖ ${i.message}\n    → at ${formatPath(i.path)}`).join("\n")}`);
}

function formatPath(path: (string | number)[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`)).join("");
}
