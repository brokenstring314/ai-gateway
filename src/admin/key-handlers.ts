/**
 * Admin API — API key management handlers.
 *
 * Keys are stored in memory via config.auth.keys. No database.
 *
 * GET    /admin/keys       — list configured keys (redacted)
 * POST   /admin/keys       — add a key
 * DELETE /admin/keys/:id   — remove a key by index
 */

import type { Context } from "hono";
import type { ConfigState } from "./config-handlers.js";

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

/** DELETE /admin/keys/:id — remove a key by its index. */
export function deleteKeyHandler(state: ConfigState) {
  return (c: Context) => {
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
