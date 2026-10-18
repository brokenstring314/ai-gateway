/**
 * ADMIN_BOOTSTRAP_KEY must stop being accepted once any real admin credential
 * exists: an admin key in the store, adminSecret, or auth.keys. It keeps
 * working on a first run with nothing configured.
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

  it("revoked or expired admin keys do not count as an admin credential", async () => {
    const { get, keyStore } = await setup();
    const k = keyStore.create("old-admin", ["admin"]);
    keyStore.revoke(k.id);
    keyStore.create("expired-admin", ["admin"], new Date(Date.now() - 60_000));
    expect((await get(BOOT)).status).toBe(200);
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
    expect((await get(BOOT, "/admin/dashboard")).status).toBe(401);
    expect((await get("client-key-1", "/v1/models")).status).toBe(200);
  });

  it("logs once when disabled, naming the reason", () => {
    const logs: string[] = [];
    let admin = false;
    const gate = createBootstrapGate({
      bootstrapKey: BOOT,
      keyStore: { hasActiveAdminKey: () => admin },
      log: (m) => logs.push(m),
    });
    expect(gate.match(BOOT)).toEqual(["admin"]);
    expect(logs).toHaveLength(0);
    admin = true;
    expect(gate.match(BOOT)).toBeUndefined();
    expect(gate.match(BOOT)).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("disabled");
    expect(logs[0]).toContain("admin key");
  });

  it("no bootstrap key configured: nothing matches, nothing logged", () => {
    const logs: string[] = [];
    const gate = createBootstrapGate({ keyStore: { hasActiveAdminKey: () => true }, log: (m) => logs.push(m) });
    expect(gate.match("")).toBeUndefined();
    expect(gate.disabledReason()).toBeDefined();
    expect(logs).toHaveLength(0);
  });

  it("startup warning only while the bootstrap key is actually live", () => {
    const noAdmin = { isEmpty: () => false, hasActiveAdminKey: () => false };
    const withAdmin = { isEmpty: () => false, hasActiveAdminKey: () => true };
    expect(clientCredentialWarning(cfg(), noAdmin, BOOT)).toContain("ADMIN_BOOTSTRAP_KEY");
    expect(clientCredentialWarning(cfg(), withAdmin, BOOT)).toBeUndefined();
    expect(clientCredentialWarning(cfg({ adminSecret: "s" }), noAdmin, BOOT)).toBeUndefined();
    expect(clientCredentialWarning(cfg({ auth: { keys: ["k"] } }), noAdmin, BOOT)).toBeUndefined();
  });
});
