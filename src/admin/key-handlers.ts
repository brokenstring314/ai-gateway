/**
 * Admin API — API key management handlers.
 *
 * KeyStore-backed handlers for the admin API:
 *   GET    /admin/keys             — list all keys (display form, no plaintext)
 *   GET    /admin/keys/:id         — get one key
 *   POST   /admin/keys             — create a key (plaintext returned once)
 *   PUT    /admin/keys/:id         — update name/scopes
 *   DELETE /admin/keys/:id         — delete a key
 *   POST   /admin/keys/:id/revoke  — revoke a key
 *   POST   /admin/keys/:id/rotate  — rotate a key (plaintext returned)
 *   GET    /admin/keys/usage       — usage aggregation
 *
 * Errors are always { error: { message, type, code } }.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { ConfigState } from "./config-handlers.js";
import {
  KeyNotFoundError,
  VALID_SCOPES,
  type APIKey,
  type KeyStore,
} from "@/persistence/key-store";

export { SCOPE_ADMIN, SCOPE_READ_ONLY, SCOPE_INFERENCE } from "@/persistence/key-store";

export interface KeyHandlerState {
  keyStore: KeyStore;
}

// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------

/** Reject requests whose keyScopes do not include any of the required scopes. */
export function requireScope(...scopes: string[]): MiddlewareHandler {
  return async function requireScopeMiddleware(c, next) {
    const keyScopes: string[] = c.get("keyScopes") ?? [];
    if (!keyScopes.some((s) => scopes.includes(s))) {
      return c.json(
        {
          error: {
            message: "Insufficient scope",
            type: "authorization_error",
            code: "insufficient_scope",
          },
        },
        403,
      );
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** JSON-safe key shape; the plaintext secret is never included. */
function serializeKey(key: APIKey) {
  return {
    id: key.id,
    keyDisplay: key.keyDisplay,
    name: key.name,
    scopes: key.scopes,
    createdAt: key.createdAt.toISOString(),
    revokedAt: key.revokedAt !== null ? key.revokedAt.toISOString() : null,
    expiresAt: key.expiresAt !== null ? key.expiresAt.toISOString() : null,
    rotatedAt: key.rotatedAt !== null ? key.rotatedAt.toISOString() : null,
    active: key.active,
    usageCount: key.usageCount,
    lastUsedAt: key.lastUsedAt !== null ? key.lastUsedAt.toISOString() : null,
  };
}

function notFound(c: Context) {
  return c.json(
    {
      error: {
        message: "Key not found",
        type: "not_found",
        code: "key_not_found",
      },
    },
    404,
  );
}

// ---------------------------------------------------------------------------
// Key handlers
// ---------------------------------------------------------------------------

/** GET /admin/keys — list all keys (display form, never plaintext). */
export function listKeysHandler(state: KeyHandlerState) {
  return (c: Context) => {
    const keys = state.keyStore.list().map(serializeKey);
    return c.json({ keys, total: keys.length });
  };
}

/** GET /admin/keys/:id — get one key. 404 when absent. */
export function getKeyHandler(state: KeyHandlerState) {
  return (c: Context) => {
    const id = c.req.param("id");
    if (id === undefined) return notFound(c);
    const key = state.keyStore.get(id);
    if (key === null) return notFound(c);
    return c.json(serializeKey(key));
  };
}

/** POST /admin/keys — create a key. Body: { name, scopes?, expiresAt? }. */
export function createKeyHandler(state: KeyHandlerState) {
  return async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
      expiresAt?: unknown;
    } | null;

    if (typeof body?.name !== "string" || body.name.trim().length === 0) {
      return c.json(
        {
          error: {
            message: "Request body must include a non-empty 'name' string",
            type: "invalid_request",
            code: "invalid_request",
          },
        },
        400,
      );
    }
    const name = body.name;

    const parsedScopes = parseScopes(body.scopes);
    if (parsedScopes === null) return invalidScopes(c);
    const scopes = parsedScopes;

    let expiresAt: Date | undefined;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== "string") {
        return invalidRequest(c, "'expiresAt' must be an ISO date string");
      }
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        return invalidRequest(c, "'expiresAt' must be an ISO date string");
      }
    }

    // Empty/omitted scopes default to ["inference"] in the store.
    const created = state.keyStore.create(name, scopes, expiresAt);
    return c.json(
      {
        id: created.id,
        key: created.key,
        keyDisplay: created.keyDisplay,
        name: created.name,
        scopes: created.scopes,
      },
      201,
    );
  };
}

/** PUT /admin/keys/:id — update name and/or scopes. 404 when absent. */
export function updateKeyHandler(state: KeyHandlerState) {
  return async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
    } | null;

    const parsedScopes = parseScopes(body?.scopes);
    if (parsedScopes === null) return invalidScopes(c);
    const scopes = parsedScopes;

    try {
      const id = c.req.param("id");
      if (id === undefined) return notFound(c);
      const updated = state.keyStore.update(
        id,
        typeof body?.name === "string" ? body.name : "",
        scopes,
      );
      return c.json(serializeKey(updated));
    } catch (err) {
      if (err instanceof KeyNotFoundError) return notFound(c);
      throw err;
    }
  };
}

/**
 * DELETE /admin/keys/:id — delete a key. 404 when absent.
 *
 * Accepts both KeyHandlerState (KeyStore-backed) and ConfigState (legacy
 * config-backed); the two call sites are wired in createAdminApp and the
 * KeyStore-based tests respectively.
 */
export function deleteKeyHandler(state: KeyHandlerState | ConfigState) {
  return (c: Context) => {
    if ("keyStore" in state) {
      try {
        const id = c.req.param("id");
        if (id === undefined) return notFound(c);
        state.keyStore.delete(id);
        return c.json({ deleted: true, id });
      } catch (err) {
        if (err instanceof KeyNotFoundError) return notFound(c);
        throw err;
      }
    }

    const idParam = c.req.param("id");
    const id = Number(idParam);

    if (Number.isNaN(id) || !Number.isInteger(id) || id < 0) {
      return c.json({ error: "Key id must be a non-negative integer" }, 400);
    }

    const keys = state.config.auth?.keys;
    if (!keys || id >= keys.length) {
      return c.json({ error: `Key id ${id} not found` }, 404);
    }

    keys.splice(id, 1);
    return c.json({ deleted: true, id });
  };
}

/** POST /admin/keys/:id/revoke — set active=false + revoked_at. */
export function revokeKeyHandler(state: KeyHandlerState) {
  return (c: Context) => {
    try {
      const id = c.req.param("id");
      if (id === undefined) return notFound(c);
      state.keyStore.revoke(id);
      return c.json({ revoked: true, id });
    } catch (err) {
      if (err instanceof KeyNotFoundError) return notFound(c);
      throw err;
    }
  };
}

/** POST /admin/keys/:id/rotate — new secret (plaintext returned once). */
export function rotateKeyHandler(state: KeyHandlerState) {
  return (c: Context) => {
    try {
      const id = c.req.param("id");
      if (id === undefined) return notFound(c);
      const rotated = state.keyStore.rotateKey(id);
      return c.json({
        id: rotated.id,
        key: rotated.key,
        keyDisplay: rotated.keyDisplay,
        name: rotated.name,
        scopes: rotated.scopes,
      });
    } catch (err) {
      if (err instanceof KeyNotFoundError) return notFound(c);
      throw err;
    }
  };
}

/** GET /admin/keys/usage — usage aggregation across all keys. */
export function keyUsageHandler(state: KeyHandlerState) {
  return (c: Context) => {
    const keys = state.keyStore.list();
    const totalUsageCount = keys.reduce((sum, k) => sum + k.usageCount, 0);
    return c.json({
      totalKeys: keys.length,
      totalUsageCount,
      keys: keys.map((k) => ({ id: k.id, name: k.name, usageCount: k.usageCount })),
    });
  };
}

// ---------------------------------------------------------------------------
// Legacy handlers (config-backed) — kept for createAdminApp compatibility
// ---------------------------------------------------------------------------

/** Redact a key for display: show first 4 and last 4 chars. */
function redactKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** GET /admin/keys — list all keys (redacted). */
export function getKeysHandler(state: ConfigState) {
  return (c: Context) => {
    const keys = state.config.auth?.keys ?? [];
    const redacted = keys.map((key, i) => ({
      id: i,
      key: redactKey(key),
    }));
    return c.json({ keys: redacted, total: keys.length });
  };
}

/** POST /admin/keys — add a new key. Body: { key: string } */
export function addKeyHandler(state: ConfigState) {
  return async (c: Context) => {
    const body = await c.req.json();
    if (typeof body?.key !== "string" || body.key.trim().length === 0) {
      return c.json({ error: "Request body must include a non-empty 'key' string" }, 400);
    }

    // Ensure auth section exists
    if (!state.config.auth) {
      state.config = {
        ...state.config,
        auth: { enabled: true, keys: [body.key] },
      };
    } else if (!state.config.auth.keys) {
      state.config = {
        ...state.config,
        auth: { ...state.config.auth, keys: [body.key] },
      };
    } else {
      state.config.auth.keys.push(body.key);
    }

    const keys = state.config.auth?.keys ?? [];
    return c.json({ id: keys.length - 1, key: redactKey(body.key) }, 201);
  };
}

/**
 * Validate a request's `scopes`: omitted → [] (store default / unchanged);
 * otherwise it must be an array of known scope strings. Returns null when
 * invalid — never silently drops entries (a dropped entry used to fall back
 * to the old ["admin"] default).
 */
function parseScopes(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  for (const scope of raw) {
    if (typeof scope !== "string" || !VALID_SCOPES.includes(scope)) return null;
  }
  return raw as string[];
}

function invalidScopes(c: Context) {
  return invalidRequest(
    c,
    `'scopes' must be an array of: ${VALID_SCOPES.map((s) => `"${s}"`).join(", ")}`,
  );
}

function invalidRequest(c: Context, message: string) {
  return c.json(
    {
      error: {
        message,
        type: "invalid_request",
        code: "invalid_request",
      },
    },
    400,
  );
}
