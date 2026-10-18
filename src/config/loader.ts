/**
 * Configuration loader — reads YAML/JSON files + environment variable overrides.
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { type ZodType, z } from "zod";
import { GatewayConfigSchema } from "./schema.js";
import { configDeprecationWarnings } from "./removed.js";
import type { GatewayConfig } from "./types.js";

const ENV_PREFIX = "AI_GATEWAY_";

/** Load config from a YAML or JSON file path. */
export function loadConfigFromPath(path: string): GatewayConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  const ext = path.split(".").pop()?.toLowerCase();
  let parsed: unknown;
  if (ext === "yaml" || ext === "yml") {
    parsed = parseYaml(raw);
  } else {
    parsed = JSON.parse(raw);
  }
  return validateConfig(parsed, path);
}

/** Load config from a plain object (for embedded mode). */
export function loadConfigFromObject(obj: unknown): GatewayConfig {
  return validateConfig(obj);
}

/** A config that failed validation; `message` lists every problem with its path. */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly z.core.$ZodIssue[],
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * The one config validator, used by `ai-gateway validate`, bootstrap() and
 * loadConfigFromObject(): AI_GATEWAY_* overrides, deprecation warnings, then
 * the strict schema with its cross-reference checks (unknown keys, removed
 * keys, unknown target references, duplicate names, missing baseURL).
 * Throws ConfigValidationError.
 */
export function validateConfig(raw: unknown, source?: string): GatewayConfig {
  const withEnv = applyEnvOverrides(raw);
  warnDeprecations(withEnv);
  const result = GatewayConfigSchema.safeParse(withEnv);
  if (!result.success) {
    throw new ConfigValidationError(
      `Invalid config${source !== undefined ? ` (${source})` : ""}:\n${z.prettifyError(result.error)}`,
      result.error.issues,
    );
  }
  return result.data as GatewayConfig;
}

function warnDeprecations(raw: unknown): void {
  for (const warning of configDeprecationWarnings(raw)) console.warn(`[config] ${warning}`);
}

/**
 * Apply environment variable overrides: AI_GATEWAY_SERVER_PORT=8080 →
 * server.port = 8080. Segments are matched case-insensitively against the
 * schema's keys, and consecutive segments join into camelCase keys
 * (AI_GATEWAY_MAX_REQUEST_BYTES → maxRequestBytes). A comma-separated value
 * for an array field becomes a list (AI_GATEWAY_CORS_ORIGINS=a,b). A variable
 * that names no config key is ignored with a warning.
 */
function applyEnvOverrides(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  const config = { ...obj } as Record<string, unknown>;

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;
    const segments = key.slice(ENV_PREFIX.length).toLowerCase().split("_").filter(Boolean);
    const resolved = resolveEnvPath(segments);
    if (resolved === undefined) {
      console.warn(`[config] ignoring ${key}: it does not name a config key`);
      continue;
    }
    setNestedValue(config, resolved.path, coerce(value, resolved.leafType));
  }

  return config;
}

/** Unwrap optional/default/pipe wrappers to the underlying schema. */
function unwrap(schema: ZodType): ZodType {
  let current = schema as ZodType & { _zod: { def: { type: string; innerType?: ZodType; in?: ZodType } } };
  for (;;) {
    const def = current._zod.def;
    if ((def.type === "optional" || def.type === "default" || def.type === "nullable") && def.innerType) {
      current = def.innerType as typeof current;
    } else if (def.type === "pipe" && def.in) {
      current = def.in as typeof current;
    } else {
      return current;
    }
  }
}

/** Env string → the leaf's type (string fields such as apiKey stay strings). */
function coerce(value: string, leafType: string): unknown {
  if (leafType === "array")
    return value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
  if (leafType === "string") return value;
  return tryParse(value);
}

function resolveEnvPath(segments: readonly string[]): { path: string[]; leafType: string } | undefined {
  const path: string[] = [];
  let schema: ZodType = GatewayConfigSchema;
  let i = 0;
  while (i < segments.length) {
    const node = unwrap(schema) as ZodType & { _zod: { def: { type: string; shape?: Record<string, ZodType> } } };
    const shape = node._zod.def.type === "object" ? node._zod.def.shape : undefined;
    if (shape === undefined) return undefined;
    let matched = false;
    for (let j = i + 1; j <= segments.length; j++) {
      const joined = segments.slice(i, j).join("");
      const key = Object.keys(shape).find((k) => k.toLowerCase() === joined);
      if (key !== undefined) {
        path.push(key);
        schema = shape[key]!;
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) return undefined;
  }
  if (path.length === 0) return undefined;
  const leaf = unwrap(schema) as ZodType & { _zod: { def: { type: string } } };
  return { path, leafType: leaf._zod.def.type };
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = current[key];
    // Copy on the way down so the caller's object is never mutated.
    current[key] = typeof next === "object" && next !== null && !Array.isArray(next) ? { ...next } : {};
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1]!;
  current[lastKey] = value;
}

function tryParse(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") return num;
  return value;
}
