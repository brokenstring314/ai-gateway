/**
 * Auth middleware — validates Bearer tokens against the KeyStore.
 *
 * authMiddleware protects non-admin routes: any valid key (store key of any
 * scope — inference, read_only, admin — or a config.auth.keys entry) is accepted.
 * adminAuthMiddleware protects /admin/* routes: admin- or read_only-scoped
 * API keys, the admin secret, or (while no real admin credential exists, see
 * auth/bootstrap.ts) bootstrap keys are accepted; inference-only keys get 403.
 *
 * All secret comparisons use timingSafeEqual — never === or Set.has().
 */

import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "@/auth/key-hash";
import type { MeteredKey } from "@/usage/key-meter";
import type { KeyStore } from "@/persistence/key-store";
import { createBootstrapGate, type BootstrapGate } from "@/auth/bootstrap";

const SCOPE_ADMIN = "admin";
const SCOPE_READ_ONLY = "read_only";

const DEFAULT_SKIP_PATHS = ["/health", "/metrics"];

export interface AuthMiddlewareOptions {
  /**
   * Optional. Without a KeyStore only configKeys are accepted (embedded mode,
   * `createApp(gateway, config)`). With neither a store nor any config key,
   * every request is rejected (fail closed).
   */
  keyStore?: KeyStore;
  bootstrapKey?: string;
  bootstrapReadOnlyKey?: string;
  skipPaths?: string[];
  /**
   * Static client keys from config.auth.keys. Read on every request so
   * runtime config edits are honored. Compared with timingSafeEqual and
   * granted no admin scopes.
   */
  configKeys?: () => readonly string[] | undefined;
  /** Admin secret, only used to decide whether bootstrap keys are still accepted. */
  adminSecret?: string;
  /** Shared bootstrap gate; built from the options above when omitted. */
  bootstrap?: BootstrapGate;
}

export function authMiddleware(opts: AuthMiddlewareOptions): MiddlewareHandler {
  const { keyStore } = opts;
  const skipPaths = new Set(opts.skipPaths ?? DEFAULT_SKIP_PATHS);
  const bootstrap =
    opts.bootstrap ??
    createBootstrapGate({
      bootstrapKey: opts.bootstrapKey,
      bootstrapReadOnlyKey: opts.bootstrapReadOnlyKey,
      keyStore,
      adminSecret: () => opts.adminSecret,
      configKeys: opts.configKeys,
    });

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

    const apiKey = keyStore?.validateKey(token) ?? null;
    if (apiKey !== null) {
      c.set("apiKey", token);
      c.set("keyScopes", apiKey.scopes);
      // Per-key model allow-list (0.3.0): enforced by the pipeline.
      if (apiKey.allowedModels !== null) c.set("allowedModels", apiKey.allowedModels);
      // Per-key quota / RPM / TPM (0.3.0 P5): checked by the pipeline against in-memory counters.
      setClient(c, {
        id: apiKey.id,
        limits: { quotaTokens: apiKey.quotaTokens, rpm: apiKey.rpm, tpm: apiKey.tpm },
        persistedUsed: apiKey.usedTokens,
      });
      await next();
      return;
    }

    const configKeys = opts.configKeys?.() ?? [];
    let configKeyMatch = false;
    let matchedIndex = -1;
    for (const [i, candidate] of configKeys.entries()) {
      // No early exit: compare against every candidate.
      if (typeof candidate === "string" && candidate !== "" && timingSafeEqual(token, candidate)) {
        configKeyMatch = true;
        matchedIndex = i;
      }
    }
    if (configKeyMatch) {
      c.set("apiKey", token);
      c.set("keyScopes", []);
      // Config keys have no own limits; usage is reported as cfg_<index> (never derived from the key).
      setClient(c, { id: configKeyId(matchedIndex) });
      await next();
      return;
    }

    // Bootstrap keys are honored only while no real admin credential exists
    // (and never without a store).
    const bootstrapScopes = bootstrap.match(token);
    if (bootstrapScopes !== undefined) {
      c.set("apiKey", token);
      c.set("keyScopes", bootstrapScopes);
      // Key-store writes under a bootstrap credential re-check the latch in
      // their transaction (admin/key-handlers.ts).
      c.set("authMethod", "bootstrap");
      await next();
      return;
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
  /** Static client keys (config.auth.keys); their presence retires bootstrap keys. */
  configKeys?: () => readonly unknown[] | undefined;
  /** Shared bootstrap gate; built from the options above when omitted. */
  bootstrap?: BootstrapGate;
}

export function adminAuthMiddleware(opts: AdminAuthMiddlewareOptions): MiddlewareHandler {
  const { keyStore } = opts;
  const bootstrap =
    opts.bootstrap ??
    createBootstrapGate({
      bootstrapKey: opts.bootstrapKey,
      bootstrapReadOnlyKey: opts.bootstrapReadOnlyKey,
      keyStore,
      adminSecret: () => opts.adminSecret,
      configKeys: opts.configKeys,
    });

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
      setActor(c, "admin-secret");
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

    const cred = resolveAdminCredential({ keyStore, adminSecret: opts.adminSecret, bootstrap }, token);
    if (cred === "insufficient_scope") {
      // A valid key without a management scope (e.g. "inference") is
      // authenticated but not authorized for /admin/*.
      return c.json(
        {
          error: {
            message: "Insufficient scope: admin or read_only required",
            type: "authorization_error",
            code: "insufficient_scope",
          },
        },
        403,
      );
    }
    if (cred === undefined) return adminUnauthorized(c);
    c.set("apiKey", token);
    c.set("keyScopes", cred.scopes);
    // Key-store writes under a bootstrap credential re-check the latch in
    // their transaction (admin/key-handlers.ts).
    if (cred.kind === "bootstrap") c.set("authMethod", "bootstrap");
    setActor(c, cred.actor);
    await next();
  };
}

/** An admin credential resolved from a presented token (never the token itself). */
export interface AdminCredential {
  kind: "secret" | "bootstrap" | "key";
  scopes: string[];
  /** Audit label: admin-secret, bootstrap-key or key:<id>. */
  actor: string;
  keyId?: string;
}

/**
 * Resolve a presented admin token: the admin secret, an active bootstrap key,
 * or a store key with the admin or read_only scope. "insufficient_scope" for a
 * valid key without either; undefined when nothing matches. Shared by the
 * Bearer middleware and the console login (admin/session-routes.ts).
 */
export function resolveAdminCredential(
  opts: { keyStore?: KeyStore; adminSecret?: string; bootstrap?: BootstrapGate },
  token: string,
): AdminCredential | "insufficient_scope" | undefined {
  if (token === "") return undefined;
  if (opts.adminSecret !== undefined && timingSafeEqual(token, opts.adminSecret)) {
    return { kind: "secret", scopes: [SCOPE_ADMIN], actor: "admin-secret" };
  }
  const bootstrapScopes = opts.bootstrap?.match(token);
  if (bootstrapScopes !== undefined) return { kind: "bootstrap", scopes: bootstrapScopes, actor: "bootstrap-key" };
  const apiKey = opts.keyStore?.validateKey(token) ?? null;
  // read_only keys are admitted; mutating admin routes enforce requireScope("admin") themselves.
  if (apiKey !== null && (apiKey.scopes.includes(SCOPE_ADMIN) || apiKey.scopes.includes(SCOPE_READ_ONLY))) {
    return { kind: "key", scopes: apiKey.scopes, actor: `key:${apiKey.id}`, keyId: apiKey.id };
  }
  if (apiKey !== null) return "insufficient_scope";
  return undefined;
}

/**
 * Usage id of a config.auth.keys entry: `cfg_<position in the list>`. Not
 * derived from the key itself: a hash of an owner-chosen (possibly weak)
 * string in the logs would allow offline guessing.
 */
export function configKeyId(index: number): string {
  return `cfg_${index}`;
}

function setClient(c: Context, client: MeteredKey): void {
  (c.set as unknown as (k: string, v: unknown) => void)("client", client);
}

/** Who is acting, for audit logs: a label or key id, never the credential. */
function setActor(c: Context, actor: string): void {
  (c.set as unknown as (k: string, v: unknown) => void)("actor", actor);
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
