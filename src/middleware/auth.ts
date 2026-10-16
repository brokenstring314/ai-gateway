/**
 * Auth middleware — validates Bearer tokens against the KeyStore.
 *
 * authMiddleware protects non-admin routes. adminAuthMiddleware protects
 * /admin/* routes: admin-scoped API keys, the admin secret, or (while the
 * store is empty) bootstrap keys are accepted.
 *
 * All secret comparisons use timingSafeEqual — never === or Set.has().
 */

import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "@/auth/key-hash";
import type { KeyStore } from "@/persistence/key-store";

const SCOPE_ADMIN = "admin";
const SCOPE_READ_ONLY = "read_only";

const DEFAULT_SKIP_PATHS = ["/health", "/metrics"];

export interface AuthMiddlewareOptions {
  keyStore: KeyStore;
  bootstrapKey?: string;
  bootstrapReadOnlyKey?: string;
  skipPaths?: string[];
  /**
   * Static client keys from config.auth.keys. Read on every request so
   * runtime config edits are honored. Compared with timingSafeEqual and
   * granted no admin scopes.
   */
  configKeys?: () => readonly string[] | undefined;
}

export function authMiddleware(opts: AuthMiddlewareOptions): MiddlewareHandler {
  const { keyStore } = opts;
  const skipPaths = new Set(opts.skipPaths ?? DEFAULT_SKIP_PATHS);

  return async function auth(c, next) {
    const path = new URL(c.req.url).pathname;
    if (skipPaths.has(path) || path === "/admin" || path.startsWith("/admin/")) {
      await next();
      return;
    }

    const header = c.req.header("Authorization");
    if (header === undefined) {
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

    const token = extractBearerToken(header);
    if (token === undefined) {
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

    const apiKey = keyStore.validateKey(token);
    if (apiKey !== null) {
      c.set("apiKey", token);
      c.set("keyScopes", apiKey.scopes);
      await next();
      return;
    }

    const configKeys = opts.configKeys?.() ?? [];
    let configKeyMatch = false;
    for (const candidate of configKeys) {
      // No early exit: compare against every candidate.
      if (typeof candidate === "string" && candidate !== "" && timingSafeEqual(token, candidate)) {
        configKeyMatch = true;
      }
    }
    if (configKeyMatch) {
      c.set("apiKey", token);
      c.set("keyScopes", []);
      await next();
      return;
    }

    // Bootstrap keys are honored only while the store has no keys at all.
    if (keyStore.isEmpty()) {
      if (opts.bootstrapKey !== undefined && timingSafeEqual(token, opts.bootstrapKey)) {
        c.set("apiKey", token);
        c.set("keyScopes", [SCOPE_ADMIN]);
        await next();
        return;
      }
      if (
        opts.bootstrapReadOnlyKey !== undefined &&
        timingSafeEqual(token, opts.bootstrapReadOnlyKey)
      ) {
        c.set("apiKey", token);
        c.set("keyScopes", [SCOPE_READ_ONLY]);
        await next();
        return;
      }
    }

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
  };
}

export interface AdminAuthMiddlewareOptions {
  keyStore: KeyStore;
  adminSecret?: string;
  bootstrapKey?: string;
  bootstrapReadOnlyKey?: string;
}

export function adminAuthMiddleware(opts: AdminAuthMiddlewareOptions): MiddlewareHandler {
  const { keyStore } = opts;

  return async function adminAuth(c, next) {
    const headerSecret = c.req.header("X-Admin-Secret");
    const token = extractBearerToken(c.req.header("Authorization"));

    if (
      headerSecret !== undefined &&
      opts.adminSecret !== undefined &&
      timingSafeEqual(headerSecret, opts.adminSecret)
    ) {
      c.set("apiKey", headerSecret);
      c.set("keyScopes", [SCOPE_ADMIN]);
      await next();
      return;
    }

    if (token === undefined) {
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

    if (
      opts.adminSecret !== undefined &&
      timingSafeEqual(token, opts.adminSecret)
    ) {
      c.set("apiKey", token);
      c.set("keyScopes", [SCOPE_ADMIN]);
      await next();
      return;
    }

    if (keyStore.isEmpty()) {
      if (opts.bootstrapKey !== undefined && timingSafeEqual(token, opts.bootstrapKey)) {
        c.set("apiKey", token);
        c.set("keyScopes", [SCOPE_ADMIN]);
        await next();
        return;
      }
      if (
        opts.bootstrapReadOnlyKey !== undefined &&
        timingSafeEqual(token, opts.bootstrapReadOnlyKey)
      ) {
        c.set("apiKey", token);
        c.set("keyScopes", [SCOPE_READ_ONLY]);
        await next();
        return;
      }
      return adminUnauthorized(c);
    }

    const apiKey = keyStore.validateKey(token);
    // read_only keys are admitted here; mutating admin routes enforce
    // requireScope("admin") themselves.
    if (
      apiKey !== null &&
      (apiKey.scopes.includes(SCOPE_ADMIN) || apiKey.scopes.includes(SCOPE_READ_ONLY))
    ) {
      c.set("apiKey", token);
      c.set("keyScopes", apiKey.scopes);
      await next();
      return;
    }

    return adminUnauthorized(c);
  };
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function adminUnauthorized(c: Context) {
  return c.json(
    {
      error: {
        message: "Invalid admin credentials",
        type: "authentication_error",
        code: "invalid_admin_secret",
      },
    },
    401,
  );
}
