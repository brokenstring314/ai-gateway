/**
 * Hono app factory — wires all middleware and handlers into a Hono instance.
 *
 * Middleware order (outermost first):
 *   1. recover        — catch-all panic recovery
 *   2. body-limit     — reject oversized request bodies
 *   3. security-headers — add security headers to all responses
 *   4. cors           — CORS headers
 *   5. auth           — Bearer token authentication
 *   6. request-timeout — AbortController-based timeout
 */

import { Hono } from "hono";
import type { Gateway } from "./gateway.js";
import type { GatewayConfig } from "./config/types.js";
import { recoverMiddleware } from "./middleware/recover.js";
import { bodyLimitMiddleware } from "./middleware/body-limit.js";
import { securityHeadersMiddleware } from "./middleware/security-headers.js";
import { corsMiddleware } from "./middleware/cors.js";
import { authMiddleware } from "./middleware/auth.js";
import { requestTimeoutMiddleware } from "./middleware/request-timeout.js";
import { registerChatHandler } from "./handlers/chat.js";
import { registerCompletionsHandler } from "./handlers/completions.js";
import { registerEmbeddingsHandler } from "./handlers/embeddings.js";
import { registerImagesHandler } from "./handlers/images.js";
import { registerModelsHandler } from "./handlers/models.js";
import { registerHealthHandler, registerLivenessHandler, registerReadinessHandler } from "./handlers/health.js";
import { registerCapabilitiesHandler } from "./handlers/capabilities.js";
import { createAdminApp } from "./admin/handlers.js";
import { getMetrics } from "./observability/metrics.js";

/** Shared Hono environment type for all handlers and middleware. */
export type AppEnv = {
  Variables: {
    apiKey: string | undefined;
    abortController: AbortController;
  };
};

export type AppType = Hono<AppEnv>;

export function createApp(gateway: Gateway, config: GatewayConfig, configPath?: string): AppType {
  const app: AppType = new Hono<AppEnv>();

  // ── Middleware (order matters) ──
  app.use("*", recoverMiddleware());
  app.use("*", bodyLimitMiddleware(config.maxRequestBytes));
  app.use("*", securityHeadersMiddleware());
  app.use("*", corsMiddleware(config.cors?.origins));
  app.use("*", authMiddleware(config.auth));
  app.use("*", requestTimeoutMiddleware(config.requestTimeout));

  // ── Handlers ──
  registerHealthHandler(app);
  registerLivenessHandler(app);
  registerReadinessHandler(app, gateway);
  registerCapabilitiesHandler(app, gateway);
  registerChatHandler(app, gateway);
  registerCompletionsHandler(app, gateway);
  registerEmbeddingsHandler(app, gateway);
  registerImagesHandler(app, gateway);
  registerModelsHandler(app, gateway);

  // ── Admin API ──
  const adminApp = createAdminApp(gateway, config, configPath);
  app.route("/admin", adminApp);

  // ── Prometheus metrics endpoint ──
  app.get("/metrics", (c) => {
    const metrics = getMetrics();
    return c.text(metrics.format(), 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  return app;
}
