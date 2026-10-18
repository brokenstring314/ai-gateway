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
import type { RequestLogStore } from "../persistence/request-log-store.js";
import { adminAuthMiddleware } from "../middleware/auth.js";
import {
  type ConfigState,
  getConfigHandler,
  removedConfigWriteHandler,
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

  const logState: LogHandlerState = { logStore: options?.logStore ?? null };
  const configState: ConfigState = { config, configPath };

  // Config (read-only; the write API was removed in 0.2.0)
  app.get("/config", getConfigHandler(configState));
  app.put("/config", removedConfigWriteHandler());
  app.delete("/config", removedConfigWriteHandler());
  app.post("/config/reload", removedConfigWriteHandler());
  app.get("/config/history", removedConfigWriteHandler());
  app.post("/config/rollback/:version", removedConfigWriteHandler());

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
    app.get("/keys", getKeysHandler(configState));
    app.post("/keys", requireScope(SCOPE_ADMIN), addKeyHandler(configState));
    app.delete("/keys/:id", requireScope(SCOPE_ADMIN), deleteKeyHandler(configState));
  }

  // Log management
  app.get("/logs", getLogsHandler(logState));
  app.get("/logs/stats", getLogsStatsHandler(logState));
  app.delete("/logs", requireScope(SCOPE_ADMIN), deleteLogsHandler(logState));

  return app;
}
