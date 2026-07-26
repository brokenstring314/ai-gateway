/**
 * Admin API — Hono sub-app mounting all admin handlers under /admin/*.
 *
 * Admin routes require an admin secret passed via X-Admin-Secret header
 * or Authorization: Bearer <admin-secret>. If no adminSecret is configured,
 * admin endpoints are disabled (return 403).
 */

import { Hono } from "hono";
import type { Gateway } from "../gateway.js";
import type { GatewayConfig } from "../config/types.js";
import { type ConfigState, getConfigHandler, putConfigHandler, reloadConfigHandler } from "./config-handlers.js";
import { getKeysHandler, addKeyHandler, deleteKeyHandler } from "./key-handlers.js";
import { logBuffer, getLogsHandler } from "./log-handlers.js";

/** Create the admin Hono sub-app with all routes mounted. */
export function createAdminApp(_gateway: Gateway, config: GatewayConfig, configPath?: string): Hono {
  const app = new Hono();

  const adminSecret = config.adminSecret;

  // Admin auth middleware — require X-Admin-Secret header or Bearer token
  app.use("*", async (c, next) => {
    if (!adminSecret) {
      return c.json({ error: { message: "Admin API disabled: no adminSecret configured", type: "forbidden", code: "admin_disabled" } }, 403);
    }

    const headerSecret = c.req.header("X-Admin-Secret")
      ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");

    if (!headerSecret || headerSecret !== adminSecret) {
      return c.json({ error: { message: "Invalid admin credentials", type: "authentication_error", code: "invalid_admin_secret" } }, 401);
    }

    await next();
  });

  // Shared mutable state for admin handlers
  const state: ConfigState = {
    config,
    configPath,
  };

  // Config management
  app.get("/config", getConfigHandler(state));
  app.put("/config", putConfigHandler(state));
  app.post("/config/reload", reloadConfigHandler(state));

  // Key management
  app.get("/keys", getKeysHandler(state));
  app.post("/keys", addKeyHandler(state));
  app.delete("/keys/:id", deleteKeyHandler(state));

  // Log viewing
  app.get("/logs", getLogsHandler(logBuffer));

  return app;
}
