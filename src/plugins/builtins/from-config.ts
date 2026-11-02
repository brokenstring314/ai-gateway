/**
 * Instantiate built-in plugins from `config.plugins`.
 *
 * Accepts names in kebab-case or snake_case ("rate-limit" / "rate_limit").
 * Each built-in's config is parsed by its strict schema (config-schemas.ts,
 * pii-secret-guard/config.ts): documented aliases (cache `ttlSeconds`/`maxAge`,
 * word-filter `blocklist`/`blockedWords`) are accepted, unknown keys throw.
 */

import type { PluginConfig } from "../../config/types.js";
import type { IPlugin, Stage } from "../types.js";
import { REMOVED_PLUGINS } from "../../config/removed.js";
import { CachePlugin } from "./cache.js";
import { MaxTokenPlugin } from "./max-token.js";
import { RateLimitPlugin } from "./rate-limit.js";
import { WordFilterPlugin } from "./word-filter.js";
import { parseBuiltinPluginConfig } from "./config-schemas.js";
import { PiiSecretGuardPlugin, resolveGuardConfig } from "./pii-secret-guard/index.js";

export interface PluginRegistration {
  readonly stage: Stage;
  readonly plugin: IPlugin;
}

let loggerRemovedWarned = false;

export function normalizePluginName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

export function buildPluginsFromConfig(entries: readonly PluginConfig[] | undefined): PluginRegistration[] {
  const out: PluginRegistration[] = [];
  for (const entry of entries ?? []) {
    if (entry.enabled === false) continue;
    const raw = entry.config ?? {};
    const name = normalizePluginName(entry.name);

    switch (name) {
      case "rate-limit": {
        const plugin = new RateLimitPlugin(parseBuiltinPluginConfig("rate-limit", entry.name, raw));
        out.push({ stage: "before_request", plugin });
        break;
      }
      case "cache": {
        const cfg = parseBuiltinPluginConfig("cache", entry.name, raw);
        // Cache needs both halves: lookup before, store after.
        out.push({ stage: "before_request", plugin: new CachePlugin(cfg, "before_request") });
        out.push({ stage: "after_request", plugin: new CachePlugin(cfg, "after_request") });
        break;
      }
      case "budget":
        // Removed in 0.3.0 (validation reports it first; embedded callers get the same message).
        throw new Error(REMOVED_PLUGINS["budget"]);
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
        const { blocklist, mode } = parseBuiltinPluginConfig("word-filter", entry.name, raw);
        if (blocklist.length === 0) {
          console.warn(`[plugins] "${entry.name}" has an empty blocklist; skipping`);
          break;
        }
        out.push({ stage: "before_request", plugin: new WordFilterPlugin({ blocklist, mode }) });
        break;
      }
      case "pii-secret-guard": {
        // Invalid config throws (validate / startup report it first, see config/validate.ts).
        const cfg = resolveGuardConfig(entry.config ?? {});
        if (cfg.scanRequest)
          out.push({ stage: "before_request", plugin: new PiiSecretGuardPlugin(cfg, "before_request") });
        if (cfg.scanResponse)
          out.push({ stage: "after_request", plugin: new PiiSecretGuardPlugin(cfg, "after_request") });
        break;
      }
      case "max-token": {
        const plugin = new MaxTokenPlugin(parseBuiltinPluginConfig("max-token", entry.name, raw));
        out.push({ stage: "before_request", plugin });
        break;
      }
      default:
        console.warn(`[plugins] unknown plugin "${entry.name}" in config; not registered`);
    }
  }
  return out;
}
