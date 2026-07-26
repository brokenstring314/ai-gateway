/**
 * Health handler — GET /health
 */

import type { AppType } from "../app.js";
import type { Gateway } from "../gateway.js";

export function registerHealthHandler(app: AppType): void {
  app.get("/health", (c) => {
    return c.json({ status: "ok" }, 200);
  });
}

export function registerLivenessHandler(app: AppType): void {
  app.get("/livez", (c) => {
    return c.json({ status: "ok" }, 200);
  });
}

export function registerReadinessHandler(app: AppType, gateway: Gateway): void {
  app.get("/readyz", (c) => {
    const registry = gateway.getRegistry();
    const config = gateway.getConfig();
    if (config && registry.size > 0) {
      return c.json({ status: "ok" }, 200);
    }
    return c.json({ status: "not ready" }, 503);
  });
}
