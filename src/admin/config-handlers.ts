/**
 * Admin API — configuration management handlers.
 *
 * GET  /admin/config          — return current config (redacted API keys)
 * PUT  /admin/config          — update config (full body, validated with Zod)
 * POST /admin/config/reload   — reload config from file
 */

import type { Context } from "hono";
import { GatewayConfigSchema } from "../config/schema.js";
import type { GatewayConfig, TargetConfig } from "../config/types.js";

/** Mutable config state shared across admin handlers. */
export interface ConfigState {
  config: GatewayConfig;
  configPath?: string;
}

/** Redact all apiKey fields in targets for safe display. */
function redactConfig(config: GatewayConfig): GatewayConfig {
  const redactedTargets: TargetConfig[] = config.targets.map((t) => ({
    ...t,
    apiKey: `${t.apiKey.slice(0, 6)}...${t.apiKey.slice(-4)}`,
  }));

  return {
    ...config,
    targets: redactedTargets,
  };
}

/** GET /admin/config — return current config with redacted API keys. */
export function getConfigHandler(state: ConfigState) {
  return (c: Context) => {
    return c.json({ config: redactConfig(state.config) });
  };
}

/** PUT /admin/config — replace config entirely, validated with Zod. */
export function putConfigHandler(state: ConfigState) {
  return async (c: Context) => {
    const body = await c.req.json();
    const result = GatewayConfigSchema.safeParse(body);

    if (!result.success) {
      return c.json(
        {
          error: "Config validation failed",
          details: result.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    }

    state.config = result.data as GatewayConfig;
    return c.json({ config: redactConfig(state.config) });
  };
}

/** POST /admin/config/reload — reload config from the original file path. */
export function reloadConfigHandler(state: ConfigState) {
  return async (c: Context) => {
    if (!state.configPath) {
      return c.json({ error: "No config file path available for reload" }, 400);
    }

    try {
      const { loadConfigFromPath } = await import("../config/loader.js");
      state.config = loadConfigFromPath(state.configPath);
      return c.json({ config: redactConfig(state.config) });
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
