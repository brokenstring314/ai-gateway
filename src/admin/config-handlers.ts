/**
 * Admin API — configuration management handlers.
 *
 * GET    /admin/config                   — current config (scrubbed)
 * PUT    /admin/config                   — replace config (Zod validated, persisted)
 * POST   /admin/config/reload            — reload config from file
 * DELETE /admin/config                   — clear persisted config, revert to file config
 * GET    /admin/config/history           — persisted config versions (scrubbed)
 * POST   /admin/config/rollback/:version — restore a persisted config version
 */

import type { Context } from "hono";
import type { ZodError } from "zod";
import type { ConfigStore } from "../persistence/config-store.js";
import { GatewayConfigSchema } from "../config/schema.js";
import type { GatewayConfig } from "../config/types.js";
import { scrubConfig, scrubConfigJson } from "./config-scrub.js";

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

/** Mutable config state shared across admin handlers. */
export interface ConfigHandlerState {
  configStore: ConfigStore | null;
  currentConfig: GatewayConfig;
  configPath?: string;
}

/** Legacy state shape used by createAdminApp and key handlers. */
export interface ConfigState {
  config: GatewayConfig;
  configPath?: string;
}

type HandlerState = ConfigHandlerState | ConfigState;

function resolveState(state: HandlerState): ConfigHandlerState {
  if ("currentConfig" in state) {
    return state;
  }
  return { configStore: null, currentConfig: state.config, configPath: state.configPath };
}

function queryInt(c: Context, key: string, fallback: number): number {
  const raw = c.req.query(key);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

function validationDetails(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** GET /admin/config — current config with secrets scrubbed. */
export function getConfigHandler(state: HandlerState) {
  return (c: Context) => {
    return c.json({ config: scrubConfig(resolveState(state).currentConfig) });
  };
}

/** PUT /admin/config — replace config; persisted when a store is available. */
export function putConfigHandler(state: HandlerState) {
  return async (c: Context) => {
    const body = await c.req.json();
    const result = GatewayConfigSchema.safeParse(body);

    if (!result.success) {
      return c.json(
        {
          error: "Config validation failed",
          details: validationDetails(result.error),
        },
        400,
      );
    }

    const data = result.data as GatewayConfig;
    const resolved = resolveState(state);
    if (resolved.configStore !== null) {
      resolved.configStore.save(JSON.stringify(data));
    }
    resolved.currentConfig = data;
    return c.json({ config: scrubConfig(data) });
  };
}

/** POST /admin/config/reload — reload config from the file path. */
export function reloadConfigHandler(state: HandlerState) {
  return async (c: Context) => {
    const resolved = resolveState(state);
    if (resolved.configPath === undefined) {
      return c.json({ error: "No config file path available for reload" }, 400);
    }

    try {
      const { loadConfigFromPath } = await import("../config/loader.js");
      resolved.currentConfig = loadConfigFromPath(resolved.configPath);
      return c.json({ config: scrubConfig(resolved.currentConfig) });
    } catch (err) {
      return c.json(
        {
          error: "Failed to reload config",
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  };
}

/** DELETE /admin/config — clear persisted config and revert to the file config. */
export function deleteConfigHandler(state: HandlerState) {
  return async (c: Context) => {
    const resolved = resolveState(state);
    if (resolved.configStore !== null) {
      resolved.configStore.delete();
    }
    if (resolved.configPath !== undefined) {
      try {
        const { loadConfigFromPath } = await import("../config/loader.js");
        resolved.currentConfig = loadConfigFromPath(resolved.configPath);
      } catch {
        // File reload is best-effort; keep the current config if it fails.
      }
    }
    return c.json({ deleted: true });
  };
}

/** GET /admin/config/history — persisted config versions, scrubbed. */
export function getConfigHistoryHandler(state: HandlerState) {
  return (c: Context) => {
    const resolved = resolveState(state);
    const limit = Math.min(
      Math.max(queryInt(c, "limit", DEFAULT_HISTORY_LIMIT), 1),
      MAX_HISTORY_LIMIT,
    );
    const offset = Math.max(queryInt(c, "offset", 0), 0);
    const all = resolved.configStore === null ? [] : resolved.configStore.loadHistory();
    const versions = all.slice(offset, offset + limit).map((v) => ({
      version: v.version,
      configJson: scrubConfigJson(v.configJson),
      updatedAt: v.updatedAt.toISOString(),
    }));
    return c.json({ versions, total: all.length });
  };
}

/** POST /admin/config/rollback/:version — restore a persisted config version. */
export function rollbackConfigHandler(state: HandlerState) {
  return (c: Context) => {
    const version = Number.parseInt(c.req.param("version") ?? "", 10);
    const resolved = resolveState(state);
    const history = resolved.configStore === null ? [] : resolved.configStore.loadHistory();
    const target = history.find((v) => v.version === version);

    if (target === undefined) {
      return c.json({ error: "Config version not found" }, 404);
    }

    const result = GatewayConfigSchema.safeParse(JSON.parse(target.configJson));
    if (!result.success) {
      return c.json(
        {
          error: "Config validation failed",
          details: validationDetails(result.error),
        },
        400,
      );
    }

    const data = result.data as GatewayConfig;
    if (resolved.configStore !== null) {
      resolved.configStore.save(JSON.stringify(data));
    }
    resolved.currentConfig = data;
    return c.json({ config: scrubConfig(data) });
  };
}
