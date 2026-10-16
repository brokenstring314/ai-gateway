import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { KeyStore } from "@/persistence/key-store";
import type { GatewayConfig } from "@/config/types";

function makeConfig(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["mock"] },
    targets: [{ name: "mock", provider: "openai", apiKey: "sk-target-secret", baseURL: "https://upstream.example/v1", models: ["gpt-4o"] }],
    adminSecret: "test-admin-secret-1234",
    ...extra,
  };
}

async function makeApp(config: GatewayConfig) {
  const keyStore = await KeyStore.create(new Database(":memory:"));
  const app = createApp(new Gateway(config), config, undefined, keyStore, { adminSecret: config.adminSecret });
  return { app, keyStore };
}

describe("config.auth.keys and auth.enabled", () => {
  it("accepts a key from config.auth.keys on /v1", async () => {
    const { app } = await makeApp(makeConfig({ auth: { enabled: true, keys: ["sk-config-client-key-123"] } }));
    const res = await app.request("/v1/models", { headers: { Authorization: "Bearer sk-config-client-key-123" } });
    expect(res.status).toBe(200);
  });

  it("still rejects unknown keys when config keys are set", async () => {
    const { app } = await makeApp(makeConfig({ auth: { enabled: true, keys: ["sk-config-client-key-123"] } }));
    const res = await app.request("/v1/models", { headers: { Authorization: "Bearer sk-config-client-key-124" } });
    expect(res.status).toBe(401);
  });

  it("config keys grant no admin access", async () => {
    const { app } = await makeApp(makeConfig({ auth: { enabled: true, keys: ["sk-config-client-key-123"] } }));
    const res = await app.request("/admin/config", { headers: { Authorization: "Bearer sk-config-client-key-123" } });
    expect(res.status).toBe(401);
  });

  it("stored keys keep working alongside config keys", async () => {
    const { app, keyStore } = await makeApp(makeConfig({ auth: { keys: ["sk-config-client-key-123"] } }));
    const stored = keyStore.create("c", ["inference"]).key;
    const res = await app.request("/v1/models", { headers: { Authorization: `Bearer ${stored}` } });
    expect(res.status).toBe(200);
  });

  it("auth.enabled: false disables client auth on /v1 but keeps /admin protected", async () => {
    const { app } = await makeApp(makeConfig({ auth: { enabled: false } }));
    expect((await app.request("/v1/models")).status).toBe(200);
    expect((await app.request("/admin/config")).status).toBe(401);
    const proxied = await app.request("/v1/unknown-endpoint", { method: "POST", headers: { "X-Provider": "nope" }, body: "{}" });
    expect(proxied.status).not.toBe(401);
  });

  it("auth enabled by default: no Authorization -> 401", async () => {
    const { app } = await makeApp(makeConfig());
    expect((await app.request("/v1/models")).status).toBe(401);
  });
});
