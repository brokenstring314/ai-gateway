import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  SCOPE_ADMIN,
  SCOPE_READ_ONLY,
  createKeyHandler,
  deleteKeyHandler,
  getKeyHandler,
  keyUsageHandler,
  listKeysHandler,
  requireScope,
  revokeKeyHandler,
  rotateKeyHandler,
  updateKeyHandler,
  type KeyHandlerState,
} from "@/admin/key-handlers";
import { KeyStore } from "@/persistence/key-store";

function createAdminApp(keyStore: KeyStore): Hono {
  const state: KeyHandlerState = { keyStore };
  const app = new Hono();
  app.get("/keys/usage", keyUsageHandler(state));
  app.get("/keys", listKeysHandler(state));
  app.post("/keys", createKeyHandler(state));
  app.get("/keys/:id", getKeyHandler(state));
  app.put("/keys/:id", updateKeyHandler(state));
  app.delete("/keys/:id", deleteKeyHandler(state));
  app.post("/keys/:id/revoke", revokeKeyHandler(state));
  app.post("/keys/:id/rotate", rotateKeyHandler(state));
  return app;
}

function createScopedApp(scopes: string[] | undefined): Hono {
  const app = new Hono();
  app.use("/admin/keys", async (c, next) => {
    if (scopes !== undefined) c.set("keyScopes", scopes);
    await next();
  });
  app.get("/admin/keys", requireScope(SCOPE_ADMIN), (c) => c.json({ ok: true }));
  return app;
}

describe("key handlers", () => {
  let db: Database;
  let keyStore: KeyStore;

  beforeEach(async () => {
    db = new Database(":memory:");
    keyStore = await KeyStore.create(db);
  });

  afterEach(() => {
    db.close();
  });

  it("create → returns plaintext fgw_ key (once)", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-key" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key.startsWith("fgw_")).toBe(true);
    expect(body.key).toHaveLength(68);
    expect(body.keyDisplay).toContain("...");
    expect(body.keyDisplay).not.toBe(body.key);
    expect(body.id).toBeTruthy();
    expect(body.name).toBe("test-key");
  });

  it("create with empty scopes → defaults to inference (not admin)", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "empty-scopes", scopes: [] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scopes).toEqual(["inference"]);
  });

  it("create with explicit scopes → preserved", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ro-key", scopes: ["read_only"] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scopes).toEqual(["read_only"]);
  });

  it("create with expiresAt → persisted on the key", async () => {
    const app = createAdminApp(keyStore);
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "expiring", expiresAt }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const stored = keyStore.get(body.id);
    expect(stored?.expiresAt).not.toBeNull();
  });

  it("create without name → 400 invalid_request", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
  });

  it("list → display form only, never plaintext", async () => {
    const plaintextA = keyStore.create("key-a", ["admin"]).key;
    const plaintextB = keyStore.create("key-b", ["read_only"]).key;
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    for (const k of body.keys) {
      expect(k.key).toBeUndefined();
      expect(k.keyDisplay).toContain("...");
      expect(k.keyDisplay).not.toBe(plaintextA);
      expect(k.keyDisplay).not.toBe(plaintextB);
    }
  });

  it("get by id → returns the key without plaintext", async () => {
    const created = keyStore.create("single", ["admin"]);
    const app = createAdminApp(keyStore);
    const res = await app.request(`/keys/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("single");
    expect(body.key).toBeUndefined();
    expect(body.keyDisplay).toBe(created.keyDisplay);
  });

  it("get non-existent → 404 key_not_found", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys/does-not-exist");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("key_not_found");
  });

  it("update name and scopes → persisted", async () => {
    const created = keyStore.create("original", ["admin"]);
    const app = createAdminApp(keyStore);
    const res = await app.request(`/keys/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed", scopes: ["read_only"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("renamed");
    expect(body.scopes).toEqual(["read_only"]);
    expect(keyStore.get(created.id)?.name).toBe("renamed");
    expect(keyStore.get(created.id)?.scopes).toEqual(["read_only"]);
  });

  it("update non-existent → 404", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys/does-not-exist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("delete → removes the key", async () => {
    const created = keyStore.create("doomed", ["admin"]);
    const app = createAdminApp(keyStore);
    const res = await app.request(`/keys/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(keyStore.get(created.id)).toBeNull();
  });

  it("delete non-existent → 404", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys/does-not-exist", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("requireScope allows a matching scope", async () => {
    const app = createScopedApp([SCOPE_ADMIN]);
    const res = await app.request("/admin/keys");
    expect(res.status).toBe(200);
  });

  it("requireScope rejects read_only caller for admin route (403)", async () => {
    const app = createScopedApp([SCOPE_READ_ONLY]);
    const res = await app.request("/admin/keys");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("Insufficient scope");
    expect(body.error.type).toBe("authorization_error");
    expect(body.error.code).toBe("insufficient_scope");
  });

  it("requireScope rejects caller with no scopes (403)", async () => {
    const app = createScopedApp(undefined);
    const res = await app.request("/admin/keys");
    expect(res.status).toBe(403);
  });
});
