import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { authMiddleware, adminAuthMiddleware } from "@/middleware/auth";
import { KeyStore } from "@/persistence/key-store";
import type { AppEnv } from "@/app";

describe("authMiddleware", () => {
  let db: Database;
  let keyStore: KeyStore;
  let adminKey: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    keyStore = await KeyStore.create(db);
    adminKey = keyStore.create("admin-key", ["admin"]).key;
  });

  afterEach(() => {
    db.close();
  });

  function createApp(opts?: { bootstrapKey?: string; bootstrapReadOnlyKey?: string; skipPaths?: string[] }) {
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware({ keyStore, ...opts }));
    app.get("/health", (c) => c.json({ ok: true }, 200));
    app.get("/metrics", (c) => c.json({ ok: true }, 200));
    app.get("/admin", (c) => c.json({ ok: true }, 200));
    app.get("/admin/config", (c) => c.json({ ok: true }, 200));
    app.post("/v1/chat/completions", (c) => c.json({ ok: true }, 200));
    return app;
  }

  it("rejects missing Authorization header (401)", async () => {
    const app = createApp();
    const res = await app.request("/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("missing_authorization");
  });

  it("rejects invalid format (401)", async () => {
    const app = createApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Basic sk-test" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_authorization");
  });

  it("rejects wrong API key (401)", async () => {
    const app = createApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer fgw_wrongkey" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("accepts valid API key", async () => {
    const app = createApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.status).toBe(200);
  });

  it("skips /health path", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("skips /metrics path", async () => {
    const app = createApp();
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
  });

  it("skips /admin path", async () => {
    const app = createApp();
    const res = await app.request("/admin");
    expect(res.status).toBe(200);
  });

  it("skips /admin/* paths", async () => {
    const app = createApp();
    const res = await app.request("/admin/config");
    expect(res.status).toBe(200);
  });

  it("accepts Bearer token with case-insensitive prefix", async () => {
    const app = createApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `bearer ${adminKey}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts bootstrap key when store is empty", async () => {
    const emptyDb = new Database(":memory:");
    const emptyStore = await KeyStore.create(emptyDb);
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware({ keyStore: emptyStore, bootstrapKey: "boot-admin" }));
    app.post("/v1/chat/completions", (c) => c.json({ ok: true }, 200));
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer boot-admin" },
    });
    expect(res.status).toBe(200);
    emptyDb.close();
  });

  it("rejects bootstrap key when store is not empty (401)", async () => {
    const app = createApp({ bootstrapKey: "boot-admin" });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer boot-admin" },
    });
    expect(res.status).toBe(401);
  });
});

describe("adminAuthMiddleware", () => {
  let db: Database;
  let keyStore: KeyStore;
  let adminKey: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    keyStore = await KeyStore.create(db);
    adminKey = keyStore.create("admin-key", ["admin"]).key;
  });

  afterEach(() => {
    db.close();
  });

  function createAdminApp(opts?: { adminSecret?: string; bootstrapKey?: string }) {
    const app = new Hono<AppEnv>();
    app.use("*", adminAuthMiddleware({ keyStore, ...opts }));
    app.get("/admin/config", (c) => c.json({ ok: true }, 200));
    return app;
  }

  it("accepts admin-scoped API key", async () => {
    const app = createAdminApp();
    const res = await app.request("/admin/config", {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects read_only-scoped API key (401)", async () => {
    const roKey = keyStore.create("ro-key", ["read_only"]).key;
    const app = createAdminApp();
    const res = await app.request("/admin/config", {
      headers: { Authorization: `Bearer ${roKey}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts X-Admin-Secret header", async () => {
    const app = createAdminApp({ adminSecret: "secret-16-characters" });
    const res = await app.request("/admin/config", {
      headers: { "X-Admin-Secret": "secret-16-characters" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts Bearer admin secret", async () => {
    const app = createAdminApp({ adminSecret: "secret-16-characters" });
    const res = await app.request("/admin/config", {
      headers: { Authorization: "Bearer secret-16-characters" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects missing credentials (401)", async () => {
    const app = createAdminApp();
    const res = await app.request("/admin/config");
    expect(res.status).toBe(401);
  });

  it("rejects wrong credentials (401)", async () => {
    const app = createAdminApp({ adminSecret: "secret-16-characters" });
    const res = await app.request("/admin/config", {
      headers: { Authorization: "Bearer wrong-secret" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts bootstrap key when store is empty", async () => {
    const emptyDb = new Database(":memory:");
    const emptyStore = await KeyStore.create(emptyDb);
    const app = new Hono<AppEnv>();
    app.use("*", adminAuthMiddleware({ keyStore: emptyStore, bootstrapKey: "boot-admin" }));
    app.get("/admin/config", (c) => c.json({ ok: true }, 200));
    const res = await app.request("/admin/config", {
      headers: { Authorization: "Bearer boot-admin" },
    });
    expect(res.status).toBe(200);
    emptyDb.close();
  });

  it("rejects bootstrap key when store is not empty (401)", async () => {
    const app = createAdminApp({ bootstrapKey: "boot-admin" });
    const res = await app.request("/admin/config", {
      headers: { Authorization: "Bearer boot-admin" },
    });
    expect(res.status).toBe(401);
  });
});
