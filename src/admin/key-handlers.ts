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
 *   PATCH  /admin/keys/:id         — change any setting incl. limits (If-Match)
 *   POST   /admin/keys/:id/reset-usage — used tokens back to 0
 *   GET    /admin/keys/usage       — usage aggregation
 *
 * Errors are always { error: { message, type, code } }.
 */

import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { ConfigState } from "./config-handlers.js";
import {
  assertLimit,
  BootstrapLatchedError,
  InvalidAllowedModelsError,
  InvalidKeyLimitError,
  InvalidScopeError,
  normalizeAllowedModels,
  KeyNotFoundError,
  KeyRevisionMismatchError,
  VALID_SCOPES,
  type APIKey,
  type KeyPatch,
  type KeyStore,
} from "@/persistence/key-store";
import { strictObject } from "@/config/strict";
import type { KeyMeter } from "@/usage/key-meter";
import { actorOf, adminError, etag, parseIfMatch } from "./guards.js";

export { SCOPE_ADMIN, SCOPE_READ_ONLY, SCOPE_INFERENCE } from "@/persistence/key-store";

export interface KeyHandlerState {
  keyStore: KeyStore;
  /** Live used-token counters (the gateway's key meter); without it the persisted value is shown. */
  meter?: KeyMeter;
  /** Audit sink for key changes (the config store's audit log, when there is one). */
  audit?: (actor: string, action: string, keyId: string, detail: Record<string, unknown>) => void;
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

/** Used tokens of a key: the live in-memory counter when the server has one, else the persisted value. */
function usedTokens(key: APIKey, meter: KeyMeter | undefined): number {
  return meter?.used(key.id) ?? key.usedTokens;
}

/** JSON-safe key shape; the plaintext secret is never included. */
function serializeKey(key: APIKey, meter?: KeyMeter) {
  const used = usedTokens(key, meter);
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
    allowedModels: key.allowedModels,
    // 0.3.0 P5: limits and usage. null limits = unlimited / global default.
    quotaTokens: key.quotaTokens,
    rpm: key.rpm,
    tpm: key.tpm,
    usedTokens: used,
    remainingTokens: key.quotaTokens === null ? null : Math.max(0, key.quotaTokens - used),
    quotaExhausted: key.quotaTokens !== null && used >= key.quotaTokens,
    usageResetAt: key.usageResetAt !== null ? key.usageResetAt.toISOString() : null,
    revision: key.revision,
  };
}

function audit(state: KeyHandlerState, c: Context, action: string, keyId: string, detail: Record<string, unknown>) {
  if (!state.audit) return;
  try {
    state.audit(actorOf(c), action, keyId, detail);
  } catch (err) {
    console.error(`[admin] could not write the audit entry for ${action} ${keyId}: ${String(err)}`);
  }
}

/** `allowedModels` from a request body: undefined = not given, null = every model, else the list. Throws on bad input. */
function parseAllowedModelsField(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) throw new InvalidAllowedModelsError(value);
  return normalizeAllowedModels(value);
}

/**
 * Writes made with a bootstrap credential must re-check the latch inside the
 * write transaction: two requests can both pass auth before either stores an
 * admin key, and only the first may succeed.
 */
function writeOptions(c: Context) {
  return { requireUnlatched: c.get("authMethod") === "bootstrap" };
}

/** Same 401 as adminAuthMiddleware gives an invalid credential. */
function bootstrapRefused(c: Context) {
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
    const keys = state.keyStore.list().map((k) => serializeKey(k, state.meter));
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
    c.header("ETag", etag(key.revision));
    return c.json(serializeKey(key, state.meter));
  };
}

/** POST /admin/keys — create a key. Body: { name, scopes?, expiresAt? }. */
export function createKeyHandler(state: KeyHandlerState) {
  return async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
      expiresAt?: unknown;
      allowedModels?: unknown;
      quotaTokens?: unknown;
      rpm?: unknown;
      tpm?: unknown;
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

    let allowedModels: string[] | null | undefined;
    try {
      allowedModels = parseAllowedModelsField(body.allowedModels);
    } catch (err) {
      return invalidRequest(c, err instanceof Error ? err.message : "invalid 'allowedModels'");
    }

    try {
      assertLimit("quotaTokens", body.quotaTokens, 0);
      assertLimit("rpm", body.rpm, 1);
      assertLimit("tpm", body.tpm, 1);
    } catch (err) {
      return invalidRequest(c, err instanceof Error ? err.message : "invalid limit");
    }
    const limits = {
      ...(body.quotaTokens !== undefined ? { quotaTokens: body.quotaTokens as number | null } : {}),
      ...(body.rpm !== undefined ? { rpm: body.rpm as number | null } : {}),
      ...(body.tpm !== undefined ? { tpm: body.tpm as number | null } : {}),
    };

    // Empty/omitted scopes default to ["inference"] in the store.
    let created: APIKey;
    try {
      created = state.keyStore.create(name, scopes, expiresAt, { ...writeOptions(c), allowedModels, ...limits });
    } catch (err) {
      if (err instanceof BootstrapLatchedError) return bootstrapRefused(c);
      throw err;
    }
    audit(state, c, "key_create", created.id, {
      name: created.name,
      scopes: created.scopes,
      quotaTokens: created.quotaTokens,
      rpm: created.rpm,
      tpm: created.tpm,
    });
    return c.json(
      {
        id: created.id,
        key: created.key,
        keyDisplay: created.keyDisplay,
        name: created.name,
        scopes: created.scopes,
        allowedModels: created.allowedModels,
        expiresAt: created.expiresAt !== null ? created.expiresAt.toISOString() : null,
        quotaTokens: created.quotaTokens,
        rpm: created.rpm,
        tpm: created.tpm,
        revision: created.revision,
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
      allowedModels?: unknown;
    } | null;

    const parsedScopes = parseScopes(body?.scopes);
    if (parsedScopes === null) return invalidScopes(c);
    const scopes = parsedScopes;
    let allowedModels: string[] | null | undefined;
    try {
      allowedModels = parseAllowedModelsField(body?.allowedModels);
    } catch (err) {
      return invalidRequest(c, err instanceof Error ? err.message : "invalid 'allowedModels'");
    }

    try {
      const id = c.req.param("id");
      if (id === undefined) return notFound(c);
      let updated = state.keyStore.update(id, typeof body?.name === "string" ? body.name : "", scopes, writeOptions(c));
      if (allowedModels !== undefined) updated = state.keyStore.setAllowedModels(id, allowedModels);
      audit(state, c, "key_update", id, { via: "PUT" });
      return c.json(serializeKey(updated, state.meter));
    } catch (err) {
      if (err instanceof KeyNotFoundError) return notFound(c);
      if (err instanceof BootstrapLatchedError) return bootstrapRefused(c);
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
        state.meter?.forget(id);
        audit(state, c, "key_delete", id, {});
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
      audit(state, c, "key_revoke", id, {});
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
      audit(state, c, "key_rotate", id, {});
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

const nullableLimit = (min: number) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER).nullable().optional();

/** PATCH /admin/keys/:id body: every field optional; null clears a limit / allow-list / expiry. */
export const KeyPatchBodySchema = strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  scopes: z
    .array(z.enum(VALID_SCOPES as [string, ...string[]]))
    .min(1)
    .optional(),
  allowedModels: z.array(z.string()).max(10_000).nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  quotaTokens: nullableLimit(0),
  rpm: nullableLimit(1),
  tpm: nullableLimit(1),
});

/**
 * PATCH /admin/keys/:id — change a key's name, scopes, allowed models,
 * expiry and limits in one transaction. Same optimistic concurrency as the
 * runtime-config API: If-Match with the key's revision (ETag of GET
 * /admin/keys/:id) is required (missing → 428, stale → 409). Audited.
 * New limits apply to the key's next request; used tokens are unchanged
 * (raising the quota re-opens an exhausted key).
 */
export function patchKeyHandler(state: KeyHandlerState) {
  return async (c: Context) => {
    const id = c.req.param("id");
    if (id === undefined) return notFound(c);
    const raw: unknown = await c.req.json().catch(() => undefined);
    const parsed = KeyPatchBodySchema.safeParse(raw ?? null);
    if (!parsed.success) return invalidRequest(c, z.prettifyError(parsed.error));
    const ifMatch = parseIfMatch(c.req.header("If-Match"));
    if (ifMatch === undefined) {
      return adminError(
        c,
        428,
        "precondition_required",
        "PATCH /admin/keys/:id needs If-Match with the key's revision",
      );
    }
    if (Number.isNaN(ifMatch)) return adminError(c, 400, "invalid_request", 'If-Match must be a revision, e.g. "3"');
    const b = parsed.data;
    const patch: KeyPatch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.scopes !== undefined) patch.scopes = b.scopes;
    if (b.allowedModels !== undefined) patch.allowedModels = b.allowedModels;
    if (b.expiresAt !== undefined) patch.expiresAt = b.expiresAt === null ? null : new Date(b.expiresAt);
    if (b.quotaTokens !== undefined) patch.quotaTokens = b.quotaTokens;
    if (b.rpm !== undefined) patch.rpm = b.rpm;
    if (b.tpm !== undefined) patch.tpm = b.tpm;
    let updated: APIKey;
    try {
      updated = state.keyStore.patch(id, patch, ifMatch, writeOptions(c));
    } catch (err) {
      if (err instanceof KeyNotFoundError) return notFound(c);
      if (err instanceof KeyRevisionMismatchError) {
        return adminError(c, 409, "revision_mismatch", "The key was changed by someone else; reload it and retry", {
          currentRevision: err.currentRevision,
        });
      }
      if (err instanceof BootstrapLatchedError) return bootstrapRefused(c);
      if (
        err instanceof InvalidAllowedModelsError ||
        err instanceof InvalidKeyLimitError ||
        err instanceof InvalidScopeError
      ) {
        return invalidRequest(c, err.message);
      }
      throw err;
    }
    audit(state, c, "key_update", id, { changed: Object.keys(patch), ...limitDetail(b) });
    c.header("ETag", etag(updated.revision));
    return c.json(serializeKey(updated, state.meter));
  };
}

function limitDetail(b: { quotaTokens?: number | null; rpm?: number | null; tpm?: number | null }) {
  const out: Record<string, unknown> = {};
  if (b.quotaTokens !== undefined) out["quotaTokens"] = b.quotaTokens;
  if (b.rpm !== undefined) out["rpm"] = b.rpm;
  if (b.tpm !== undefined) out["tpm"] = b.tpm;
  return out;
}

/**
 * POST /admin/keys/:id/reset-usage — set the key's used tokens back to 0
 * (in memory at once, persisted in the same call) and record when. If-Match
 * is optional here (checked when given). Requests already running keep
 * running; their tokens count toward the fresh total. Audited.
 */
export function resetKeyUsageHandler(state: KeyHandlerState) {
  return (c: Context) => {
    const id = c.req.param("id");
    if (id === undefined) return notFound(c);
    const ifMatch = parseIfMatch(c.req.header("If-Match"));
    if (ifMatch !== undefined && Number.isNaN(ifMatch)) {
      return adminError(c, 400, "invalid_request", 'If-Match must be a revision, e.g. "3"');
    }
    const current = state.keyStore.get(id);
    if (current === null) return notFound(c);
    if (ifMatch !== undefined && ifMatch !== current.revision) {
      return adminError(c, 409, "revision_mismatch", "The key was changed by someone else; reload it and retry", {
        currentRevision: current.revision,
      });
    }
    const before = usedTokens(current, state.meter);
    let updated: APIKey;
    try {
      updated = state.keyStore.resetUsage(id);
    } catch (err) {
      if (err instanceof KeyNotFoundError) return notFound(c);
      throw err;
    }
    state.meter?.reset(id);
    audit(state, c, "key_reset_usage", id, { usedTokensBefore: before });
    c.header("ETag", etag(updated.revision));
    return c.json(serializeKey(updated, state.meter));
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
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        usageCount: k.usageCount,
        usedTokens: usedTokens(k, state.meter),
        quotaTokens: k.quotaTokens,
      })),
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
  return invalidRequest(c, `'scopes' must be an array of: ${VALID_SCOPES.map((s) => `"${s}"`).join(", ")}`);
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
