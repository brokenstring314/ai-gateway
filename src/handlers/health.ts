/**
 * Health handler — GET /health
 */

import type { AppType } from "../app.js";

export function registerHealthHandler(app: AppType): void {
  app.get("/health", (c) => {
    return c.json({ status: "ok" }, 200);
  });
}
