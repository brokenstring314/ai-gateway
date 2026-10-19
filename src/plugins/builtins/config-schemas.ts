/**
 * Strict config schemas for the built-in plugins (except pii-secret-guard,
 * which has its own in pii-secret-guard/config.ts). One schema per plugin,
 * listing exactly the keys the plugin reads (documented aliases included),
 * used both by `ai-gateway validate` / startup (config/validate.ts) and by
 * the plugin factory (from-config.ts), so a typo is a validation error rather
 * than a silently ignored key.
 */

import { z } from "zod";
import { strictObject } from "../../config/strict.js";

const positiveInt = z.number().int().positive();
const positiveNumber = z.number().positive();
const nonNegativeNumber = z.number().nonnegative();

/**
 * Keys that name the same setting (`maxAge` = `ttlSeconds`). At most one may
 * be set; `required` groups need exactly one.
 */
type AliasGroup = { readonly keys: readonly [string, ...string[]]; readonly required?: boolean };

function aliasCheck<T extends Record<string, unknown>>(groups: readonly AliasGroup[]) {
  return (cfg: T, ctx: z.RefinementCtx) => {
    for (const { keys, required } of groups) {
      const set = keys.filter((k) => cfg[k] !== undefined);
      if (set.length > 1) {
        ctx.addIssue({ code: "custom", path: [set[1]!], message: `set only one of ${keys.join(" / ")}` });
      } else if (set.length === 0 && required === true) {
        ctx.addIssue({
          code: "custom",
          path: [keys[0]],
          message: `${keys[0]} is required${keys.length > 1 ? ` (aliases: ${keys.slice(1).join(", ")})` : ""}`,
        });
      }
    }
  };
}

function first<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((v) => v !== undefined);
}

export const RateLimitPluginConfigSchema = strictObject({
  maxRequestsPerMinute: positiveInt.optional(),
  keyRpm: positiveInt.optional(),
  rpm: positiveInt.optional(),
  maxRequestsPerDay: positiveInt.optional(),
  rpd: positiveInt.optional(),
  key: z.string().min(1).optional(),
})
  .superRefine(
    aliasCheck([
      { keys: ["maxRequestsPerMinute", "keyRpm", "rpm"], required: true },
      { keys: ["maxRequestsPerDay", "rpd"] },
    ]),
  )
  .transform((c) => ({
    maxRequestsPerMinute: first(c.maxRequestsPerMinute, c.keyRpm, c.rpm) as number,
    maxRequestsPerDay: first(c.maxRequestsPerDay, c.rpd),
    key: c.key,
  }));

export const CachePluginConfigSchema = strictObject({
  ttlSeconds: positiveNumber.optional(),
  maxAge: positiveNumber.optional(),
  maxSize: positiveInt.optional(),
  maxEntries: positiveInt.optional(),
})
  .superRefine(aliasCheck([{ keys: ["ttlSeconds", "maxAge"] }, { keys: ["maxSize", "maxEntries"] }]))
  .transform((c) => ({
    ttlSeconds: first(c.ttlSeconds, c.maxAge) ?? 300,
    maxSize: first(c.maxSize, c.maxEntries) ?? 1000,
  }));

export const BudgetPluginConfigSchema = strictObject({
  dailyBudget: positiveNumber,
  costPer1kInput: nonNegativeNumber.optional(),
  costPer1kOutput: nonNegativeNumber.optional(),
  reserveOutputTokens: z.number().int().nonnegative().optional(),
});

export const WordFilterPluginConfigSchema = strictObject({
  blocklist: z.array(z.string()).optional(),
  blockedWords: z.array(z.string()).optional(),
  mode: z.enum(["reject", "redact"]).optional().default("reject"),
})
  .superRefine(aliasCheck([{ keys: ["blocklist", "blockedWords"] }]))
  .transform((c) => ({ blocklist: first(c.blocklist, c.blockedWords) ?? [], mode: c.mode }));

export const MaxTokenPluginConfigSchema = strictObject({
  maxTokens: positiveInt,
});

/** Schema per built-in plugin name (normalized kebab-case). */
export const BUILTIN_PLUGIN_CONFIG_SCHEMAS = {
  "rate-limit": RateLimitPluginConfigSchema,
  cache: CachePluginConfigSchema,
  budget: BudgetPluginConfigSchema,
  "word-filter": WordFilterPluginConfigSchema,
  "max-token": MaxTokenPluginConfigSchema,
} as const;

export type BuiltinPluginWithSchema = keyof typeof BUILTIN_PLUGIN_CONFIG_SCHEMAS;

export interface PluginConfigIssue {
  path: (string | number)[];
  message: string;
}

function hasSchema(name: string): name is BuiltinPluginWithSchema {
  return Object.hasOwn(BUILTIN_PLUGIN_CONFIG_SCHEMAS, name);
}

/** Problems in a built-in plugin's config; empty for a valid config or a plugin without a schema here. */
export function builtinPluginConfigIssues(name: string, raw: unknown): PluginConfigIssue[] {
  if (!hasSchema(name)) return [];
  const parsed = BUILTIN_PLUGIN_CONFIG_SCHEMAS[name].safeParse(raw ?? {});
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
    message: i.message,
  }));
}

/** Parse a built-in plugin's config; throws one Error naming every problem (embedded path). */
export function parseBuiltinPluginConfig<N extends BuiltinPluginWithSchema>(
  name: N,
  entryName: string,
  raw: unknown,
): z.output<(typeof BUILTIN_PLUGIN_CONFIG_SCHEMAS)[N]> {
  const parsed = BUILTIN_PLUGIN_CONFIG_SCHEMAS[name].safeParse(raw ?? {});
  if (parsed.success) return parsed.data as z.output<(typeof BUILTIN_PLUGIN_CONFIG_SCHEMAS)[N]>;
  const msg = parsed.error.issues
    .map((i) => `config${i.path.length > 0 ? `.${i.path.join(".")}` : ""}: ${i.message}`)
    .join("; ");
  throw new Error(`Plugin "${entryName}": invalid config: ${msg}`);
}
