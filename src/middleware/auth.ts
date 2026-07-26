/**
 * Auth middleware — validates Bearer token against configured API keys.
 * If auth is disabled, passes through without checking.
 * Sets api_key in context for downstream plugins/handlers.
 */

import type { MiddlewareHandler } from "hono";

interface AuthConfig {
  enabled?: boolean;
  keys?: string[];
}

export function authMiddleware(config?: AuthConfig): MiddlewareHandler {
  const enabled = config?.enabled ?? false;
  const keys = new Set(config?.keys ?? []);

  const skipPaths = new Set(["/health", "/metrics"]);

  return async function auth(c, next) {
    if (!enabled || keys.size === 0) {
      c.set("apiKey", undefined);
      await next();
      return;
    }

    const path = new URL(c.req.url).pathname;
    if (skipPaths.has(path) || path.startsWith("/admin/") || path === "/admin") {
      c.set("apiKey", undefined);
      await next();
      return;
    }

    const header = c.req.header("Authorization");
    if (!header) {
      return c.json(
        {
          error: {
            message: "Missing Authorization header",
            type: "authentication_error",
            code: "missing_authorization",
          },
        },
        401,
      );
    }

    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json(
        {
          error: {
            message: "Invalid Authorization header format; expected Bearer <token>",
            type: "authentication_error",
            code: "invalid_authorization",
          },
        },
        401,
      );
    }

    const token = match[1]!;
    if (!keys.has(token)) {
      return c.json(
        {
          error: {
            message: "Invalid API key",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        },
        401,
      );
    }

    c.set("apiKey", token);
    await next();
  };
}
