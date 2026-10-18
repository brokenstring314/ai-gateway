/**
 * Config for the pii-secret-guard plugin: one strict schema, used both by
 * `ai-gateway validate` / startup (config/validate.ts) and by the plugin
 * factory, so a typo is a validation error rather than a silent no-op.
 */

import { z } from "zod";
import { BUILTIN_DETECTORS, BUILTIN_ENTITIES, type Category, type Detector } from "./detectors.js";

export const GUARD_ACTIONS = ["block", "redact", "log"] as const;
export type GuardAction = (typeof GUARD_ACTIONS)[number];

export const GUARD_SURFACES = ["chat", "completions", "embeddings", "passthrough"] as const;
export type GuardSurface = (typeof GUARD_SURFACES)[number];

export const GUARD_ROLES = ["system", "user", "assistant", "tool", "developer"] as const;
export type GuardRole = (typeof GUARD_ROLES)[number];

export const GUARD_DIRECTIONS = ["request", "response", "both"] as const;
export type GuardDirection = (typeof GUARD_DIRECTIONS)[number];

const ActionSchema = z.enum(GUARD_ACTIONS);
const regexString = z
  .string()
  .min(1)
  .refine((s) => s.trim() !== "", "must be a non-empty pattern")
  .refine((s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  }, "must be a valid regular expression");

const CustomPatternSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "must be lower_snake_case (a-z, 0-9, _)"),
  pattern: regexString,
  category: z.enum(["pii", "secret"]).optional().default("secret"),
  action: ActionSchema.optional(),
});

export const PiiSecretGuardConfigSchema = z
  .strictObject({
    /** Default action for every detection (default block). */
    action: ActionSchema.optional().default("block"),
    /** Per-category action, overriding `action`. */
    categories: z.strictObject({ pii: ActionSchema.optional(), secret: ActionSchema.optional() }).optional(),
    /** Built-in entities to scan for; absent = every built-in except opt-in ones (ipv4). */
    entities: z.array(z.string()).optional(),
    /** Per-entity action, overriding the category / default action. Naming an entity here also enables it. */
    entityActions: z.record(z.string(), ActionSchema).optional(),
    /** Regexes tested against each matched VALUE; a value that matches any is ignored. */
    allowlist: z.array(regexString).optional().default([]),
    /** Operator-defined detectors, reported as `custom` entities. */
    patterns: z.array(CustomPatternSchema).optional().default([]),
    surfaces: z.array(z.enum(GUARD_SURFACES)).min(1).optional(),
    roles: z.array(z.enum(GUARD_ROLES)).min(1).optional(),
    direction: z.enum(GUARD_DIRECTIONS).optional().default("request"),
    /** Minimum Shannon entropy (bits/char) for generic `api_key=` / `password=` values. */
    entropyThreshold: z.number().min(0).max(8).optional().default(3.5),
    /** Scan assistant tool-call arguments (default true). */
    scanToolArguments: z.boolean().optional().default(true),
  })
  .superRefine((cfg, ctx) => {
    const custom = new Set(cfg.patterns.map((p) => p.name));
    cfg.patterns.forEach((p, i) => {
      if (BUILTIN_ENTITIES.includes(p.name))
        ctx.addIssue({
          code: "custom",
          path: ["patterns", i, "name"],
          message: `"${p.name}" is a built-in entity; pick another name`,
        });
    });
    if (custom.size !== cfg.patterns.length)
      ctx.addIssue({ code: "custom", path: ["patterns"], message: "pattern names must be unique" });
    (cfg.entities ?? []).forEach((e, i) => {
      if (!BUILTIN_ENTITIES.includes(e))
        ctx.addIssue({
          code: "custom",
          path: ["entities", i],
          message: `unknown entity "${e}"; expected one of ${BUILTIN_ENTITIES.join(", ")}`,
        });
    });
    for (const e of Object.keys(cfg.entityActions ?? {})) {
      if (!BUILTIN_ENTITIES.includes(e) && !custom.has(e))
        ctx.addIssue({
          code: "custom",
          path: ["entityActions", e],
          message: `unknown entity "${e}"; expected a built-in (${BUILTIN_ENTITIES.join(", ")}) or a patterns[].name`,
        });
    }
    if (cfg.entities !== undefined && cfg.entities.length === 0 && cfg.patterns.length === 0 && !cfg.entityActions)
      ctx.addIssue({
        code: "custom",
        path: ["entities"],
        message: "entities is empty and no patterns are set: the plugin would detect nothing",
      });
  });

export type PiiSecretGuardInput = z.input<typeof PiiSecretGuardConfigSchema>;

/** Resolved, ready-to-run configuration. */
export interface ResolvedGuardConfig {
  readonly detectors: readonly Detector[];
  readonly customEntities: ReadonlySet<string>;
  readonly actionOf: (entity: string, category: Category) => GuardAction;
  readonly allowlist: readonly RegExp[];
  readonly surfaces: ReadonlySet<GuardSurface>;
  readonly roles: ReadonlySet<GuardRole>;
  readonly scanRequest: boolean;
  readonly scanResponse: boolean;
  readonly entropyThreshold: number;
  readonly scanToolArguments: boolean;
}

export type GuardConfigIssue = { path: (string | number)[]; message: string };

/** Issues in a raw `config` block (empty = valid). */
export function piiSecretGuardConfigIssues(raw: unknown): GuardConfigIssue[] {
  const parsed = PiiSecretGuardConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
    message: i.message,
  }));
}

/** Parse and resolve; throws one Error naming every problem. */
export function resolveGuardConfig(raw: unknown): ResolvedGuardConfig {
  const parsed = PiiSecretGuardConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Plugin "pii-secret-guard": invalid config: ${msg}`);
  }
  const cfg = parsed.data;
  const entityActions = cfg.entityActions ?? {};
  const selected = new Set(cfg.entities ?? BUILTIN_DETECTORS.filter((d) => d.optIn !== true).map((d) => d.entity));
  for (const e of Object.keys(entityActions)) if (BUILTIN_ENTITIES.includes(e)) selected.add(e);

  const detectors: Detector[] = BUILTIN_DETECTORS.filter((d) => selected.has(d.entity));
  // Custom detectors come after the built-ins: a built-in hit keeps its type.
  for (const p of cfg.patterns) {
    detectors.push({ entity: p.name, category: p.category, pattern: new RegExp(p.pattern, "dg") });
  }
  const customActions = new Map(cfg.patterns.filter((p) => p.action).map((p) => [p.name, p.action!]));

  return {
    detectors,
    customEntities: new Set(cfg.patterns.map((p) => p.name)),
    actionOf: (entity, category) =>
      entityActions[entity] ?? customActions.get(entity) ?? cfg.categories?.[category] ?? cfg.action,
    allowlist: cfg.allowlist.map((s) => new RegExp(s)),
    surfaces: new Set(cfg.surfaces ?? GUARD_SURFACES),
    roles: new Set(cfg.roles ?? GUARD_ROLES),
    scanRequest: cfg.direction !== "response",
    scanResponse: cfg.direction !== "request",
    entropyThreshold: cfg.entropyThreshold,
    scanToolArguments: cfg.scanToolArguments,
  };
}
