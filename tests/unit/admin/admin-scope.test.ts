import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { KeyStore } from "@/persistence/key-store";
import { RequestLogStore } from "@/persistence/request-log-store";
import type { GatewayConfig } from "@/config/types";

const RO = "readonly-bootstrap-key-xyz";

function makeConfig(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["mock"] },
    targets: [
      {
        name: "mock",
        provider: "openai",
        apiKey: "sk-target-secret",
        baseURL: "https://upstream.example/v1",
        models: ["gpt-4o"],
      },
    ],
    adminSecret: "test-admin-secret-1234",
    ...extra,
  };
}

async function makeApp(opts: { bootstrapReadOnlyKey?: string } = {}) {
  // Bootstrap keys are only live while no real admin credential exists, so
  // the bootstrap cases run without adminSecret.
  const config = opts.bootstrapReadOnlyKey !== undefined ? makeConfig({ adminSecret: undefined }) : makeConfig();
  const keyStore = await KeyStore.create(new Database(":memory:"));
  const logStore = await RequestLogStore.create(new Database(":memory:"));
  const app = createApp(new Gateway(config), config, undefined, keyStore, {
    logStore,
    adminSecret: config.adminSecret,
    bootstrapReadOnlyKey: opts.bootstrapReadOnlyKey,
  });
  return { app, keyStore };
}

describe("admin scope enforcement", () => {
  it("read_only bootstrap key gets 403 on DELETE /admin/logs", async () => {
    const { app } = await makeApp({ bootstrapReadOnlyKey: RO });
    const res = await app.request("/admin/logs", { method: "DELETE", headers: { Authorization: `Bearer ${RO}` } });
    expect(res.status).toBe(403);
  });

  it("stored read_only key can read admin GET routes but not mutate", async () => {
    const { app, keyStore } = await makeApp();
    keyStore.create("admin", ["admin"]);
    const ro = keyStore.create("viewer", ["read_only"]).key;
    const h = { Authorization: `Bearer ${ro}` };
    expect((await app.request("/admin/keys/usage", { headers: h })).status).toBe(200);
    expect((await app.request("/admin/config", { headers: h })).status).toBe(200);
    expect((await app.request("/admin/logs", { method: "DELETE", headers: h })).status).toBe(403);
    expect(
      (
        await app.request("/admin/keys", {
          method: "POST",
          headers: { ...h, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x" }),
        })
      ).status,
    ).toBe(403);
  });
});

describe("config write API removed (0.2.0)", () => {
  const removed: Array<[string, string]> = [
    ["PUT", "/admin/config"],
    ["DELETE", "/admin/config"],
    ["POST", "/admin/config/reload"],
    ["GET", "/admin/config/history"],
    ["POST", "/admin/config/rollback/1"],
  ];
  for (const [method, path] of removed) {
    it(`${method} ${path} -> 410 config_api_removed, config unchanged`, async () => {
      const { app, keyStore } = await makeApp();
      const admin = keyStore.create("admin", ["admin"]).key;
      const h = { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" };
      const res = await app.request(path, {
        method,
        headers: h,
        body:
          method === "GET" ? undefined : JSON.stringify({ ...makeConfig(), adminSecret: "attacker-controlled-secret" }),
      });
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("config_api_removed");
      expect(body.error.message).toContain("restart");
      // The old secret still works: nothing was swapped.
      const get = await app.request("/admin/config", { headers: { "X-Admin-Secret": "test-admin-secret-1234" } });
      expect(get.status).toBe(200);
    });
  }

  it("read_only key is also refused (no takeover path)", async () => {
    const { app } = await makeApp({ bootstrapReadOnlyKey: RO });
    const res = await app.request("/admin/config", {
      method: "PUT",
      headers: { Authorization: `Bearer ${RO}`, "Content-Type": "application/json" },
      body: JSON.stringify(makeConfig({ adminSecret: "x" })),
    });
    expect([403, 410]).toContain(res.status);
  });
});
