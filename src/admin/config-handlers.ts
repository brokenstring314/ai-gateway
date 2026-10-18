/**
 * Admin API — configuration (read-only).
 *
 * GET /admin/config — the config the gateway started with, secrets scrubbed.
 *
 * Since 0.2.0 there is no runtime config write API (PUT/reload/rollback/DELETE
 * and history were removed): the config file is the only source of truth.
 * Change it and restart (rolling restart behind a load balancer).
 */

import type { Context } from "hono";
import type { GatewayConfig } from "../config/types.js";
import { scrubConfig } from "./config-scrub.js";

/** Config state shared by the admin handlers. */
export interface ConfigState {
  config: GatewayConfig;
  configPath?: string;
}

/** GET /admin/config — current config with secrets scrubbed. */
export function getConfigHandler(state: ConfigState) {
  return (c: Context) => c.json({ config: scrubConfig(state.config) });
}

/** Removed write endpoints answer 410 with a migration hint instead of a bare 404. */
export function removedConfigWriteHandler() {
  return (c: Context) =>
    c.json(
      {
        error: {
          message:
            "The runtime config write API (PUT/DELETE /admin/config, /admin/config/reload, " +
            "/admin/config/history, /admin/config/rollback) was removed in 0.2.0. " +
            "Edit the config file and restart the gateway.",
          type: "invalid_request_error",
          code: "config_api_removed",
        },
      },
      410,
    );
}
