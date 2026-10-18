/**
 * Instantiate built-in plugins from `config.plugins`.
 *
 * Accepts names in kebab-case or snake_case ("rate-limit" / "rate_limit"),
 * and both the code-level config keys and the documented aliases
 * (e.g. cache `ttlSeconds`/`maxAge`, word-filter `blocklist`/`blockedWords`).
 */

import type { PluginConfig } from "../../config/types.js";
import type { IPlugin, Stage } from "../types.js";
import { BudgetPlugin } from "./budget.js";
import { CachePlugin } from "./cache.js";
import { MaxTokenPlugin } from "./max-token.js";
import { RateLimitPlugin } from "./rate-limit.js";
import { WordFilterPlugin } from "./word-filter.js";

export interface PluginRegistration {
  readonly stage: Stage;
  readonly plugin: IPlugin;
}

type Raw = Record<string, unknown>;

function num(raw: Raw, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function requirePositive(plugin: string, raw: Raw, keys: readonly string[]): number {
  const v = num(raw, keys);
  if (v === undefined || v <= 0) {
    throw new Error(`Plugin "${plugin}": config.${keys[0] ?? "?"} must be a positive number`);
  }
  return v;
}

function strings(raw: Raw, keys: readonly string[]): string[] {
  for (const k of keys) {
    const v = raw[k];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

let loggerRemovedWarned = false;

export function normalizePluginName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

export function buildPluginsFromConfig(
  entries: readonly PluginConfig[] | undefined,
): PluginRegistration[] {
  const out: PluginRegistration[] = [];
  for (const entry of entries ?? []) {
    if (entry.enabled === false) continue;
    const raw: Raw = (entry.config ?? {}) as Raw;
    const name = normalizePluginName(entry.name);

    switch (name) {
      case "rate-limit": {
        const plugin = new RateLimitPlugin({
          maxRequestsPerMinute: requirePositive(entry.name, raw, ["maxRequestsPerMinute", "keyRpm", "rpm"]),
          maxRequestsPerDay: num(raw, ["maxRequestsPerDay", "rpd"]),
          key: typeof raw["key"] === "string" ? raw["key"] : undefined,
        });
        out.push({ stage: "before_request", plugin });
        break;
      }
      case "cache": {
        const cfg = {
          ttlSeconds: num(raw, ["ttlSeconds", "maxAge"]) ?? 300,
          maxSize: num(raw, ["maxSize", "maxEntries"]) ?? 1000,
        };
        // Cache needs both halves: lookup before, store after.
        out.push({ stage: "before_request", plugin: new CachePlugin(cfg, "before_request") });
        out.push({ stage: "after_request", plugin: new CachePlugin(cfg, "after_request") });
        break;
      }
      case "budget": {
        const cfg = {
          dailyBudget: requirePositive(entry.name, raw, ["dailyBudget"]),
          costPer1kInput: num(raw, ["costPer1kInput"]),
          costPer1kOutput: num(raw, ["costPer1kOutput"]),
        };
        // Budget checks before and accrues spend after.
        out.push({ stage: "before_request", plugin: new BudgetPlugin(cfg, "before_request") });
        out.push({ stage: "after_request", plugin: new BudgetPlugin(cfg, "after_request") });
        break;
      }
      case "logger": {
        // Removed in 0.2.0: it duplicated the gateway's own request log.
        // Accepted (so old configs still start) but ignored, with one warning.
        if (!loggerRemovedWarned) {
          loggerRemovedWarned = true;
          console.warn(
            '[plugins] the "logger" plugin was removed in 0.2.0 and is ignored: the gateway already writes one ' +
              "request-log line per request. Remove it from config.plugins.",
          );
        }
        break;
      }
      case "word-filter": {
        const blocklist = strings(raw, ["blocklist", "blockedWords"]);
        if (blocklist.length === 0) {
          console.warn(`[plugins] "${entry.name}" has an empty blocklist; skipping`);
          break;
        }
        const mode = raw["mode"] === "redact" ? "redact" : "reject";
        out.push({ stage: "before_request", plugin: new WordFilterPlugin({ blocklist, mode }) });
        break;
      }
      case "max-token": {
        const plugin = new MaxTokenPlugin({
          maxTokens: requirePositive(entry.name, raw, ["maxTokens"]),
        });
        out.push({ stage: "before_request", plugin });
        break;
      }
      default:
        console.warn(`[plugins] unknown plugin "${entry.name}" in config; not registered`);
    }
  }
  return out;
}
