import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { KeyStore } from "@/persistence/key-store";
import { ConfigStore } from "@/persistence/config-store";
import { RequestLogStore } from "@/persistence/request-log-store";
import type { GatewayConfig } from "@/config/types";

const RO = "readonly-bootstrap-key-xyz";

function makeConfig(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["mock"] },
    targets: [{ name: "mock", provider: "openai", apiKey: "sk-target-secret", baseURL: "https://upstream.example/v1", models: ["gpt-4o"] }],
    adminSecret: "test-admin-secret-1234",
    ...extra,
  };
}

async function makeApp(opts: { bootstrapReadOnlyKey?: string } = {}) {
  const config = makeConfig();
  const keyStore = await KeyStore.create(new Database(":memory:"));
  const configStore = await ConfigStore.create(new Database(":memory:"));
  const logStore = await RequestLogStore.create(new Database(":memory:"));
  const app = createApp(new Gateway(config), config, undefined, keyStore, {
    configStore,
    logStore,
    adminSecret: config.adminSecret,
    bootstrapReadOnlyKey: opts.bootstrapReadOnlyKey,
  });
  return { app, keyStore, configStore };
}

describe("admin scope enforcement", () => {
  it("read_only bootstrap key cannot PUT /admin/config (no adminSecret takeover)", async () => {
    const { app, configStore } = await makeApp({ bootstrapReadOnlyKey: RO });
    const res = await app.request("/admin/config", {
      method: "PUT",
      headers: { Authorization: `Bearer ${RO}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...makeConfig(), adminSecret: "attacker-controlled-secret" }),
    });
    expect(res.status).toBe(403);
    expect(configStore.load()).toBeNull();
  });

  const mutating: Array<[string, string]> = [
    ["DELETE", "/admin/config"],
    ["POST", "/admin/config/reload"],
    ["POST", "/admin/config/rollback/1"],
    ["DELETE", "/admin/logs"],
  ];
  for (const [method, path] of mutating) {
    it(`read_only bootstrap key gets 403 on ${method} ${path}`, async () => {
      const { app } = await makeApp({ bootstrapReadOnlyKey: RO });
      const res = await app.request(path, { method, headers: { Authorization: `Bearer ${RO}` } });
      expect(res.status).toBe(403);
    });
  }

  it("stored read_only key can read admin GET routes but not mutate", async () => {
    const { app, keyStore } = await makeApp();
    keyStore.create("admin", ["admin"]);
    const ro = keyStore.create("viewer", ["read_only"]).key;
    const h = { Authorization: `Bearer ${ro}` };
    expect((await app.request("/admin/keys/usage", { headers: h })).status).toBe(200);
    expect((await app.request("/admin/config", { headers: h })).status).toBe(200);
    expect((await app.request("/admin/config/history", { headers: h })).status).toBe(200);
    expect((await app.request("/admin/config", { method: "DELETE", headers: h })).status).toBe(403);
    expect((await app.request("/admin/logs", { method: "DELETE", headers: h })).status).toBe(403);
    expect((await app.request("/admin/keys", { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) })).status).toBe(403);
  });

  it("stored admin key can still mutate", async () => {
    const { app, keyStore } = await makeApp();
    const admin = keyStore.create("admin", ["admin"]).key;
    const res = await app.request("/admin/config", { method: "DELETE", headers: { Authorization: `Bearer ${admin}` } });
    expect(res.status).toBe(200);
  });
});
