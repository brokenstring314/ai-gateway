import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { timingSafeEqual } from "@/auth/key-hash";
import {
  adminAuthMiddleware,
  authMiddleware,
  type AdminAuthMiddlewareOptions,
  type AuthMiddlewareOptions,
} from "@/middleware/auth";
import { KeyStore } from "@/persistence/key-store";

function createAuthApp(keyStore: KeyStore, opts: Partial<AuthMiddlewareOptions> = {}): Hono {
  const app = new Hono();
  app.use("/protected", authMiddleware({ keyStore, ...opts }));
  app.get("/protected", (c) => c.json({ ok: true, keyScopes: c.get("keyScopes") }));
  return app;
}

function createAdminAuthApp(keyStore: KeyStore, opts: Partial<AdminAuthMiddlewareOptions> = {}): Hono {
  const app = new Hono();
  app.use("/admin/*", adminAuthMiddleware({ keyStore, ...opts }));
  app.get("/admin/keys", (c) => c.json({ ok: true }));
  return app;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("timingSafeEqual", () => {
  it("equal strings → true", () => {
    expect(timingSafeEqual("fgw_abc123", "fgw_abc123")).toBe(true);
  });

  it("different strings → false", () => {
    expect(timingSafeEqual("fgw_abc123", "fgw_abc124")).toBe(false);
  });

  it("different lengths → false", () => {
    expect(timingSafeEqual("short", "a-much-longer-secret")).toBe(false);
  });
});

describe("authMiddleware", () => {
  let db: Database;
  let keyStore: KeyStore;

  beforeEach(async () => {
    db = new Database(":memory:");
    keyStore = await KeyStore.create(db);
  });

  afterEach(() => {
    db.close();
  });

  it("valid API key passes with its scopes", async () => {
    const created = keyStore.create("admin-key", ["admin"]);
    const app = createAuthApp(keyStore);
    const res = await app.request("/protected", { headers: bearer(created.key) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyScopes).toEqual(["admin"]);
  });

  it("bootstrapKey on empty store → admin scope", async () => {
    const app = createAuthApp(keyStore, { bootstrapKey: "boot-admin-123" });
    const res = await app.request("/protected", { headers: bearer("boot-admin-123") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyScopes).toEqual(["admin"]);
  });

  it("bootstrapReadOnlyKey on empty store → read_only scope", async () => {
    const app = createAuthApp(keyStore, { bootstrapReadOnlyKey: "boot-ro-456" });
    const res = await app.request("/protected", { headers: bearer("boot-ro-456") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyScopes).toEqual(["read_only"]);
  });

  it("bootstrap key rejected when store is not empty (401)", async () => {
    keyStore.create("real-key", ["admin"]);
    const app = createAuthApp(keyStore, { bootstrapKey: "boot-admin-123" });
    const res = await app.request("/protected", { headers: bearer("boot-admin-123") });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("wrong bootstrap key on empty store → 401", async () => {
    const app = createAuthApp(keyStore, { bootstrapKey: "boot-admin-123" });
    const res = await app.request("/protected", { headers: bearer("wrong-boot") });
    expect(res.status).toBe(401);
  });

  it("missing Authorization header → 401 missing_authorization", async () => {
    const app = createAuthApp(keyStore);
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("missing_authorization");
  });
});

describe("adminAuthMiddleware", () => {
  let db: Database;
  let keyStore: KeyStore;

  beforeEach(async () => {
    db = new Database(":memory:");
    keyStore = await KeyStore.create(db);
  });

  afterEach(() => {
    db.close();
  });

  it("adminSecret via X-Admin-Secret header passes", async () => {
    const app = createAdminAuthApp(keyStore, { adminSecret: "secret-abc-123" });
    const res = await app.request("/admin/keys", {
      headers: { "X-Admin-Secret": "secret-abc-123" },
    });
    expect(res.status).toBe(200);
  });

  it("admin-scoped API key passes", async () => {
    const created = keyStore.create("adm", ["admin"]);
    const app = createAdminAuthApp(keyStore, { adminSecret: "secret-abc-123" });
    const res = await app.request("/admin/keys", { headers: bearer(created.key) });
    expect(res.status).toBe(200);
  });

  it("read_only API key admitted by adminAuth (routes enforce write scope)", async () => {
    const created = keyStore.create("ro", ["read_only"]);
    const app = createAdminAuthApp(keyStore);
    const res = await app.request("/admin/keys", { headers: bearer(created.key) });
    expect(res.status).toBe(200);
  });

  it("bootstrapKey on empty store passes", async () => {
    const app = createAdminAuthApp(keyStore, { bootstrapKey: "boot-admin-123" });
    const res = await app.request("/admin/keys", { headers: bearer("boot-admin-123") });
    expect(res.status).toBe(200);
  });

  it("wrong credentials rejected (401)", async () => {
    const app = createAdminAuthApp(keyStore, { adminSecret: "secret-abc-123" });
    const res = await app.request("/admin/keys", { headers: bearer("nope") });
    expect(res.status).toBe(401);
  });
});
