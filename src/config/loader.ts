/**
 * Configuration loader — reads YAML/JSON files + environment variable overrides.
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "./schema.js";
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
  const withEnv = applyEnvOverrides(parsed);
  return parseConfig(withEnv);
}

/** Load config from a plain object (for embedded mode). */
export function loadConfigFromObject(obj: unknown): GatewayConfig {
  const withEnv = applyEnvOverrides(obj);
  return parseConfig(withEnv);
}

/** Apply environment variable overrides. AI_GATEWAY_SERVER_PORT=8080 → config.server.port = 8080 */
function applyEnvOverrides(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  const config = { ...obj } as Record<string, unknown>;

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;
    const configPath = key
      .slice(ENV_PREFIX.length)
      .toLowerCase()
      .split("_");
    setNestedValue(config, configPath, value);
  }

  return config;
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: string): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1]!;
  // Try to parse as number or boolean
  current[lastKey] = tryParse(value);
}

function tryParse(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") return num;
  return value;
}
