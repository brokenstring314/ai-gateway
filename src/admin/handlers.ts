/**
 * Admin API — Hono sub-app mounting all admin handlers under /admin/*.
 *
 * Admin routes are protected by adminAuthMiddleware: admin- or read_only-scoped
 * API keys, the admin secret (X-Admin-Secret or Bearer), or bootstrap keys
 * (while the key store is empty) are accepted. Every mutating route is further
 * gated by requireScope(SCOPE_ADMIN), so read_only credentials can only read. If no keyStore is provided, the legacy
 * X-Admin-Secret-only check applies.
 */

import { Hono } from "hono";
import type { Gateway } from "../gateway.js";
import type { GatewayConfig } from "../config/types.js";
import type { KeyStore } from "../persistence/key-store.js";
import type { ConfigStore } from "../persistence/config-store.js";
import type { RequestLogStore } from "../persistence/request-log-store.js";
import { adminAuthMiddleware } from "../middleware/auth.js";
import {
  type ConfigHandlerState,
  type ConfigState,
  getConfigHandler,
  putConfigHandler,
  reloadConfigHandler,
  deleteConfigHandler,
  getConfigHistoryHandler,
  rollbackConfigHandler,
} from "./config-handlers.js";
import {
  type KeyHandlerState,
  SCOPE_ADMIN,
  requireScope,
  listKeysHandler,
  getKeyHandler,
  createKeyHandler,
  updateKeyHandler,
  deleteKeyHandler,
  revokeKeyHandler,
  rotateKeyHandler,
  keyUsageHandler,
  getKeysHandler,
  addKeyHandler,
} from "./key-handlers.js";
import {
  type LogHandlerState,
  getLogsHandler,
  getLogsStatsHandler,
  deleteLogsHandler,
} from "./log-handlers.js";

export interface AdminAppOptions {
  keyStore?: KeyStore;
  configStore?: ConfigStore;
  logStore?: RequestLogStore;
  adminSecret?: string;
  bootstrapKey?: string;
  bootstrapReadOnlyKey?: string;
}

export type AdminAppEnv = {
  Variables: {
    apiKey: string | undefined;
    keyScopes: string[] | undefined;
  };
};

/** Create the admin Hono sub-app with all routes mounted. */
export function createAdminApp(
  _gateway: Gateway,
  config: GatewayConfig,
  configPath?: string,
  options?: AdminAppOptions,
): Hono<AdminAppEnv> {
  const app = new Hono<AdminAppEnv>();

  const keyStore = options?.keyStore;
  const adminSecret = options?.adminSecret ?? config.adminSecret;

  if (keyStore) {
    app.use("*", adminAuthMiddleware({
      keyStore,
      adminSecret,
      bootstrapKey: options?.bootstrapKey,
      bootstrapReadOnlyKey: options?.bootstrapReadOnlyKey,
    }));
  } else {
    app.use("*", async (c, next) => {
      if (!adminSecret) {
        return c.json({ error: { message: "Admin API disabled: no adminSecret configured", type: "forbidden", code: "admin_disabled" } }, 403);
      }
      const headerSecret = c.req.header("X-Admin-Secret")
        ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
      if (!headerSecret || headerSecret !== adminSecret) {
        return c.json({ error: { message: "Invalid admin credentials", type: "authentication_error", code: "invalid_admin_secret" } }, 401);
      }
      c.set("apiKey", headerSecret);
      c.set("keyScopes", ["admin"]);
      await next();
    });
  }

  const configState: ConfigHandlerState = {
    configStore: options?.configStore ?? null,
    currentConfig: config,
    configPath,
  };
  const logState: LogHandlerState = { logStore: options?.logStore ?? null };
  const legacyConfigState: ConfigState = { config: config, configPath };

  // Config management
  app.get("/config", getConfigHandler(configState));
  app.put("/config", requireScope(SCOPE_ADMIN), putConfigHandler(configState));
  app.post("/config/reload", requireScope(SCOPE_ADMIN), reloadConfigHandler(configState));
  app.delete("/config", requireScope(SCOPE_ADMIN), deleteConfigHandler(configState));
  app.get("/config/history", getConfigHistoryHandler(configState));
  app.post("/config/rollback/:version", requireScope(SCOPE_ADMIN), rollbackConfigHandler(configState));

  // Key management
  if (keyStore) {
    const keyState: KeyHandlerState = { keyStore };
    app.get("/keys", requireScope(SCOPE_ADMIN), listKeysHandler(keyState));
    app.get("/keys/usage", keyUsageHandler(keyState));
    app.get("/keys/:id", getKeyHandler(keyState));
    app.post("/keys", requireScope(SCOPE_ADMIN), createKeyHandler(keyState));
    app.put("/keys/:id", requireScope(SCOPE_ADMIN), updateKeyHandler(keyState));
    app.delete("/keys/:id", requireScope(SCOPE_ADMIN), deleteKeyHandler(keyState));
    app.post("/keys/:id/revoke", requireScope(SCOPE_ADMIN), revokeKeyHandler(keyState));
    app.post("/keys/:id/rotate", requireScope(SCOPE_ADMIN), rotateKeyHandler(keyState));
  } else {
    app.get("/keys", getKeysHandler(legacyConfigState));
    app.post("/keys", requireScope(SCOPE_ADMIN), addKeyHandler(legacyConfigState));
    app.delete("/keys/:id", requireScope(SCOPE_ADMIN), deleteKeyHandler(legacyConfigState));
  }

  // Log management
  app.get("/logs", getLogsHandler(logState));
  app.get("/logs/stats", getLogsStatsHandler(logState));
  app.delete("/logs", requireScope(SCOPE_ADMIN), deleteLogsHandler(logState));

  return app;
}
