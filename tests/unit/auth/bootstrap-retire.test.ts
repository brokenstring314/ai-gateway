/**
 * ADMIN_BOOTSTRAP_KEY must stop being accepted once any real admin credential
 * exists: an admin key was ever created in the store (one-way latch),
 * adminSecret, or auth.keys. It keeps working on a first run with nothing
 * configured, and never comes back after the latch is set.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "@/app";
import { Gateway } from "@/gateway";
import { KeyStore } from "@/persistence/key-store";
import { createBootstrapGate } from "@/auth/bootstrap";
import { clientCredentialWarning } from "@/index";
import type { GatewayConfig } from "@/config/types";

const BOOT = "boot-admin-key-0123456789";
const BOOT_RO = "boot-ro-key-0123456789";

function cfg(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["mock"] },
    targets: [
      { name: "mock", provider: "openai", apiKey: "sk-x", baseURL: "https://upstream.example/v1", models: ["gpt-4o"] },
    ],
    ...extra,
  };
}

const dbs: Database[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

async function setup(extra: Partial<GatewayConfig> = {}) {
  const db = new Database(":memory:");
  dbs.push(db);
  const keyStore = await KeyStore.create(db);
  const config = cfg(extra);
  const app = createApp(new Gateway(config), config, undefined, keyStore, {
    adminSecret: config.adminSecret,
    bootstrapKey: BOOT,
    bootstrapReadOnlyKey: BOOT_RO,
  });
  const get = (token: string, path = "/admin/keys") =>
    app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  return { app, keyStore, config, get };
}

describe("bootstrap admin key retirement", () => {
  it("first run with nothing configured: bootstrap key works on /admin and /v1", async () => {
    const { get } = await setup();
    expect((await get(BOOT)).status).toBe(200);
    expect((await get(BOOT, "/v1/models")).status).toBe(200);
    expect((await get(BOOT_RO, "/admin/keys/usage")).status).toBe(200);
  });

  it("refused once the store has an admin key", async () => {
    const { get, keyStore } = await setup();
    expect((await get(BOOT)).status).toBe(200);
    keyStore.create("real-admin", ["admin"]);
    expect((await get(BOOT)).status).toBe(401);
    expect((await get(BOOT, "/v1/models")).status).toBe(401);
    expect((await get(BOOT_RO, "/admin/keys/usage")).status).toBe(401);
  });

  it("still accepted while the store only has inference keys (no admin yet)", async () => {
    const { get, keyStore } = await setup();
    keyStore.create("client", ["inference"]);
    expect((await get(BOOT)).status).toBe(200);
  });

  it("stays refused after every admin key is revoked, expires or is deleted (one-way latch)", async () => {
    const { get, keyStore } = await setup();
    const k = keyStore.create("old-admin", ["admin"]);
    expect((await get(BOOT)).status).toBe(401);
    keyStore.revoke(k.id);
    expect((await get(BOOT)).status).toBe(401);
    keyStore.delete(k.id);
    expect(keyStore.isEmpty()).toBe(true);
    expect((await get(BOOT)).status).toBe(401);
    expect((await get(BOOT, "/v1/models")).status).toBe(401);
    expect((await get(BOOT_RO, "/admin/keys/usage")).status).toBe(401);
  });

  it("an already-expired admin key also latches", async () => {
    const { get, keyStore } = await setup();
    keyStore.create("expired-admin", ["admin"], new Date(Date.now() - 60_000));
    expect((await get(BOOT)).status).toBe(401);
  });

  it("granting admin to an existing key via update latches", async () => {
    const { get, keyStore } = await setup();
    const k = keyStore.create("client", ["inference"]);
    expect((await get(BOOT)).status).toBe(200);
    keyStore.update(k.id, "", ["admin"]);
    keyStore.update(k.id, "", ["inference"]);
    expect((await get(BOOT)).status).toBe(401);
  });

  it("the refusal has the same shape as an invalid credential", async () => {
    const { get, keyStore } = await setup();
    keyStore.create("real-admin", ["admin"]);
    const refused = await get(BOOT);
    const invalid = await get("not-a-key-at-all-0123");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(await invalid.json());
    const refusedV1 = await get(BOOT, "/v1/models");
    const invalidV1 = await get("not-a-key-at-all-0123", "/v1/models");
    expect(await refusedV1.json()).toEqual(await invalidV1.json());
  });

  it("bootstrap key creates the first admin key over HTTP, then is refused", async () => {
    const { app, get } = await setup();
    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${BOOT}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "first-admin", scopes: ["admin"] }),
    });
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };
    expect((await get(BOOT)).status).toBe(401);
    expect((await get(key)).status).toBe(200);
  });

  it("concurrent bootstrap-key admin creations: exactly one succeeds", async () => {
    const { app, keyStore } = await setup();
    const post = (name: string) =>
      app.request("/admin/keys", {
        method: "POST",
        headers: { Authorization: `Bearer ${BOOT}`, "content-type": "application/json" },
        body: JSON.stringify({ name, scopes: ["admin"] }),
      });
    // Fired together, so every request passes the auth gate before any of
    // them stores its key (the handler awaits the body first).
    const results = await Promise.all([post("a"), post("b"), post("c"), post("d")]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 401, 401, 401]);
    const refused = results.find((r) => r.status === 401)!;
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid_admin_secret");
    expect(keyStore.list().filter((k) => k.scopes.includes("admin"))).toHaveLength(1);
  });

  it("a real admin key is not limited by the latch", async () => {
    const { app, keyStore } = await setup();
    const admin = keyStore.create("real-admin", ["admin"]);
    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "second-admin", scopes: ["admin"] }),
    });
    expect(res.status).toBe(201);
  });

  it("refused when adminSecret is set", async () => {
    const { get } = await setup({ adminSecret: "real-admin-secret-123" });
    expect((await get(BOOT)).status).toBe(401);
    expect((await get(BOOT, "/v1/models")).status).toBe(401);
    expect((await get(BOOT_RO, "/admin/keys/usage")).status).toBe(401);
    expect((await get("real-admin-secret-123")).status).toBe(200);
  });

  it("refused when auth.keys are configured", async () => {
    const { get } = await setup({ auth: { keys: ["client-key-1"] } });
    expect((await get(BOOT)).status).toBe(401);
    expect((await get(BOOT, "/v1/models")).status).toBe(401);
    expect((await get(BOOT, "/admin/status")).status).toBe(401);
    expect((await get("client-key-1", "/v1/models")).status).toBe(200);
  });

  it("logs once when latched, telling the operator to remove the key and how to recover", () => {
    const logs: string[] = [];
    let latchedAt: Date | null = null;
    const gate = createBootstrapGate({
      bootstrapKey: BOOT,
      keyStore: { bootstrapLatchedAt: () => latchedAt },
      log: (m) => logs.push(m),
    });
    expect(gate.match(BOOT)).toEqual(["admin"]);
    expect(logs).toHaveLength(0);
    latchedAt = new Date("2026-10-18T00:00:00Z");
    expect(gate.match(BOOT)).toBeUndefined();
    expect(gate.match(BOOT)).toBeUndefined();
    expect(gate.disabledReason()).toContain("bootstrap latch is set");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("permanently disabled");
    expect(logs[0]).toContain("remove them from the environment");
    expect(logs[0]).toContain("ai-gateway keys create --admin");
    expect(logs[0]).not.toContain(BOOT);
  });

  it("startup: ADMIN_BOOTSTRAP_KEY still set on a latched store logs one warning", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const keyStore = await KeyStore.create(db);
    const k = keyStore.create("admin", ["admin"]);
    keyStore.revoke(k.id);
    const logs: string[] = [];
    const gate = createBootstrapGate({ bootstrapKey: BOOT, keyStore, log: (m) => logs.push(m) });
    gate.disabledReason(); // what server bootstrap() does at startup
    gate.match(BOOT);
    gate.match(BOOT);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("remove them from the environment");
  });

  it("no bootstrap key configured: nothing matches, nothing logged", () => {
    const logs: string[] = [];
    const gate = createBootstrapGate({ keyStore: { bootstrapLatchedAt: () => new Date() }, log: (m) => logs.push(m) });
    expect(gate.match("")).toBeUndefined();
    expect(gate.disabledReason()).toBeDefined();
    expect(logs).toHaveLength(0);
  });

  it("startup warning only while the bootstrap key is actually live", () => {
    const noAdmin = { isEmpty: () => false, isBootstrapLatched: () => false };
    const withAdmin = { isEmpty: () => false, isBootstrapLatched: () => true };
    expect(clientCredentialWarning(cfg(), noAdmin, BOOT)).toContain("ADMIN_BOOTSTRAP_KEY");
    expect(clientCredentialWarning(cfg(), withAdmin, BOOT)).toBeUndefined();
    expect(clientCredentialWarning(cfg({ adminSecret: "s" }), noAdmin, BOOT)).toBeUndefined();
    expect(clientCredentialWarning(cfg({ auth: { keys: ["k"] } }), noAdmin, BOOT)).toBeUndefined();
  });
});
