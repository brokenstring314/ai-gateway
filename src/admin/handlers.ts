/**
 * Admin API — Hono sub-app mounting all admin handlers under /admin/*.
 *
 * Admin routes are protected by adminAuthMiddleware: admin- or read_only-scoped
 * API keys, the admin secret (X-Admin-Secret or Bearer), or bootstrap keys
 * (until the first admin credential exists, see auth/bootstrap.ts) are accepted. Every mutating route is further
 * gated by requireScope(SCOPE_ADMIN), so read_only credentials can only read. If no keyStore is provided, the legacy
 * X-Admin-Secret-only check applies.
 */

import { Hono } from "hono";
import type { Gateway } from "../gateway.js";
import type { GatewayConfig } from "../config/types.js";
import type { KeyStore } from "../persistence/key-store.js";
import type { RequestLogStore } from "../persistence/request-log-store.js";
import { adminAuthMiddleware } from "../middleware/auth.js";
import type { BootstrapGate } from "../auth/bootstrap.js";
import { type ConfigState, getConfigHandler, removedConfigWriteHandler } from "./config-handlers.js";
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
  patchKeyHandler,
  resetKeyUsageHandler,
  getKeysHandler,
  addKeyHandler,
} from "./key-handlers.js";
import { getStatusHandler } from "./status-handlers.js";
import type { ConfigStore } from "../persistence/config-store.js";
import { registerRuntimeConfigApi, type RuntimeConfigApiOptions } from "./config-api.js";
import { csrfGuard } from "./guards.js";
import { type LogHandlerState, getLogsHandler, getLogsStatsHandler, deleteLogsHandler } from "./log-handlers.js";
import { usageHandler } from "./usage-handlers.js";
import type { UsageStore } from "../usage/usage-store.js";
import type { UsageRecorder } from "../usage/recorder.js";

export interface AdminAppOptions {
  keyStore?: KeyStore;
  /** Runtime config store (runtimeConfig.source: database); without it the config API is read-only. */
  configStore?: ConfigStore;
  /** Runtime-config API tuning (tests: DNS resolver, probe limits, backups). */
  configApi?: Omit<RuntimeConfigApiOptions, "gateway" | "store" | "allowedOrigins">;
  logStore?: RequestLogStore;
  /** Usage rollups behind GET /admin/usage (server mode) and the recorder feeding them. */
  usageStore?: UsageStore;
  usageRecorder?: UsageRecorder;
  adminSecret?: string;
  bootstrapKey?: string;
  bootstrapReadOnlyKey?: string;
  /** Shared bootstrap-key gate (see auth/bootstrap.ts). */
  bootstrap?: BootstrapGate;
}

export type AdminAppEnv = {
  Variables: {
    apiKey: string | undefined;
    keyScopes: string[] | undefined;
  };
};

/** Create the admin Hono sub-app with all routes mounted. */
export function createAdminApp(
  gateway: Gateway,
  config: GatewayConfig,
  configPath?: string,
  options?: AdminAppOptions,
): Hono<AdminAppEnv> {
  const app = new Hono<AdminAppEnv>();

  const keyStore = options?.keyStore;
  const adminSecret = options?.adminSecret ?? config.adminSecret;

  if (keyStore) {
    app.use(
      "*",
      adminAuthMiddleware({
        keyStore,
        adminSecret,
        bootstrapKey: options?.bootstrapKey,
        bootstrapReadOnlyKey: options?.bootstrapReadOnlyKey,
        configKeys: () => config.auth?.keys,
        bootstrap: options?.bootstrap,
      }),
    );
  } else {
    app.use("*", async (c, next) => {
      if (!adminSecret) {
        return c.json(
          {
            error: {
              message: "Admin API disabled: no adminSecret configured",
              type: "forbidden",
              code: "admin_disabled",
            },
          },
          403,
        );
      }
      const headerSecret = c.req.header("X-Admin-Secret") ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
      if (!headerSecret || headerSecret !== adminSecret) {
        return c.json(
          {
            error: { message: "Invalid admin credentials", type: "authentication_error", code: "invalid_admin_secret" },
          },
          401,
        );
      }
      c.set("apiKey", headerSecret);
      c.set("keyScopes", ["admin"]);
      (c.set as unknown as (k: string, v: unknown) => void)("actor", "admin-secret");
      await next();
    });
  }

  // Every state-changing admin request: no cross-site origin, JSON bodies only (admin/guards.ts).
  app.use("*", csrfGuard({ allowedOrigins: () => config.cors?.origins }));

  const logState: LogHandlerState = { logStore: options?.logStore ?? null };
  const configState: ConfigState = { config, configPath, current: () => gateway.getConfig() };

  // Console overview (scopes, breakers, MCP, request summary)
  app.get("/status", getStatusHandler(gateway));

  // Runtime config API (0.3.0 P4): channels, keys, models, settings, versions, audit, presets.
  registerRuntimeConfigApi(app as never, {
    ...(options?.configApi ?? {}),
    gateway,
    ...(options?.configStore ? { store: options.configStore } : {}),
    allowedOrigins: () => config.cors?.origins,
  });

  // The whole running config (secrets scrubbed); the 0.2.0 write endpoints below stay removed.
  app.get("/config", getConfigHandler(configState));
  app.put("/config", removedConfigWriteHandler());
  app.delete("/config", removedConfigWriteHandler());
  app.post("/config/reload", removedConfigWriteHandler());
  app.get("/config/history", removedConfigWriteHandler());
  app.post("/config/rollback/:version", removedConfigWriteHandler());

  // Key management
  if (keyStore) {
    const configStore = options?.configStore;
    const keyState: KeyHandlerState = {
      keyStore,
      meter: gateway.keyMeter(),
      ...(configStore
        ? {
            audit: (actor: string, action: string, id: string, detail: Record<string, unknown>) =>
              configStore.auditOnly(actor, action, "api_key", id, detail),
          }
        : {}),
    };
    // Listing never returns plaintext; read_only may read it like every other GET.
    app.get("/keys", listKeysHandler(keyState));
    app.get("/keys/usage", keyUsageHandler(keyState));
    app.get("/keys/:id", getKeyHandler(keyState));
    app.post("/keys", requireScope(SCOPE_ADMIN), createKeyHandler(keyState));
    app.put("/keys/:id", requireScope(SCOPE_ADMIN), updateKeyHandler(keyState));
    app.patch("/keys/:id", requireScope(SCOPE_ADMIN), patchKeyHandler(keyState));
    app.post("/keys/:id/reset-usage", requireScope(SCOPE_ADMIN), resetKeyUsageHandler(keyState));
    app.delete("/keys/:id", requireScope(SCOPE_ADMIN), deleteKeyHandler(keyState));
    app.post("/keys/:id/revoke", requireScope(SCOPE_ADMIN), revokeKeyHandler(keyState));
    app.post("/keys/:id/rotate", requireScope(SCOPE_ADMIN), rotateKeyHandler(keyState));
  } else {
    app.get("/keys", getKeysHandler(configState));
    app.post("/keys", requireScope(SCOPE_ADMIN), addKeyHandler(configState));
    app.delete("/keys/:id", requireScope(SCOPE_ADMIN), deleteKeyHandler(configState));
  }

  // Usage statistics (0.3.0 P5): tokens / requests / errors / latency by key, model or channel.
  app.get(
    "/usage",
    usageHandler({
      ...(options?.usageStore ? { store: options.usageStore } : {}),
      ...(options?.usageRecorder ? { recorder: options.usageRecorder } : {}),
      ...(keyStore ? { keyStore } : {}),
    }),
  );

  // Log management
  app.get("/logs", getLogsHandler(logState));
  app.get("/logs/stats", getLogsStatsHandler(logState));
  app.delete("/logs", requireScope(SCOPE_ADMIN), deleteLogsHandler(logState));

  return app;
}
