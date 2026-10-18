import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  createKeyHandler,
  deleteKeyHandler,
  getKeyHandler,
  keyUsageHandler,
  listKeysHandler,
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

describe("key revoke and rotate", () => {
  let db: Database;
  let keyStore: KeyStore;

  beforeEach(async () => {
    db = new Database(":memory:");
    keyStore = await KeyStore.create(db);
  });

  afterEach(() => {
    db.close();
  });

  it("revoke → active=false and revoked_at set", async () => {
    const created = keyStore.create("rev-key", ["admin"]);
    const app = createAdminApp(keyStore);
    const res = await app.request(`/keys/${created.id}/revoke`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestJson;
    expect(body.revoked).toBe(true);
    const stored = keyStore.get(created.id);
    expect(stored?.active).toBe(false);
    expect(stored?.revokedAt).not.toBeNull();
  });

  it("revoke non-existent → 404", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys/does-not-exist/revoke", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("rotate → returns a new plaintext key", async () => {
    const created = keyStore.create("rot-key", ["admin"]);
    const originalKey = created.key;
    const app = createAdminApp(keyStore);
    const res = await app.request(`/keys/${created.id}/rotate`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestJson;
    expect(body.key.startsWith("fgw_")).toBe(true);
    expect(body.key).not.toBe(originalKey);
  });

  it("rotate → old key is no longer valid", async () => {
    const created = keyStore.create("rot-key", ["admin"]);
    const originalKey = created.key;
    const app = createAdminApp(keyStore);
    await app.request(`/keys/${created.id}/rotate`, { method: "POST" });
    expect(keyStore.validateKey(originalKey)).toBeNull();
  });

  it("rotate → new key is valid", async () => {
    const created = keyStore.create("rot-key", ["admin"]);
    const app = createAdminApp(keyStore);
    const res = await app.request(`/keys/${created.id}/rotate`, { method: "POST" });
    const body = (await res.json()) as TestJson;
    const validated = keyStore.validateKey(body.key);
    expect(validated).not.toBeNull();
    expect(validated?.id).toBe(created.id);
  });

  it("rotate non-existent → 404", async () => {
    const app = createAdminApp(keyStore);
    const res = await app.request("/keys/does-not-exist/rotate", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("usage endpoint aggregates counts across keys", async () => {
    const a = keyStore.create("key-a", ["admin"]);
    const b = keyStore.create("key-b", ["read_only"]);
    keyStore.validateKey(a.key);
    keyStore.validateKey(a.key);
    keyStore.validateKey(b.key);

    const app = createAdminApp(keyStore);
    const res = await app.request("/keys/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestJson;
    expect(body.totalKeys).toBe(2);
    expect(body.totalUsageCount).toBe(3);
    const byId = new Map<string, { id: string; name: string; usageCount: number }>(
      body.keys.map((k: { id: string; name: string; usageCount: number }) => [k.id, k]),
    );
    expect(byId.get(a.id)?.usageCount).toBe(2);
    expect(byId.get(b.id)?.usageCount).toBe(1);
    expect(byId.get(a.id)?.name).toBe("key-a");
    expect(byId.get(b.id)?.name).toBe("key-b");
  });
});
