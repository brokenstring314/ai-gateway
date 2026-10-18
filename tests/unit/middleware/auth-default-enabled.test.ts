// Regression (SEC2-1): `auth: { keys: [...] }` without an explicit `enabled` used to
// be parsed by the Zod schema as enabled:false, and since c0881e5 app.ts honored
// that -> client auth was skipped and the /v1 proxy ran with
// allowUnauthenticatedProxy=true, letting anonymous callers spend the operator's
// upstream key. Auth must be disabled ONLY by an explicit `enabled: false`.
import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { KeyStore } from "@/persistence/key-store";
import { parseConfig } from "@/config/schema";
import { authExposureWarning, isClientAuthEnabled } from "@/config/production-safety";
import type { GatewayConfig } from "@/config/types";

let seenAuth: string | null = null;
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    seenAuth = req.headers.get("authorization");
    return Response.json({ ok: true });
  },
});
afterAll(() => upstream.stop(true));

async function appFor(raw: unknown) {
  const config = parseConfig(raw) as GatewayConfig; // same path as loadConfigFromPath / persisted config
  const keyStore = await KeyStore.create(new Database(":memory:"));
  return {
    config,
    app: createApp(new Gateway(config), config, undefined, keyStore, { adminSecret: config.adminSecret }),
  };
}

const base = {
  strategy: { mode: "single", targets: ["up"] },
  targets: [
    {
      name: "up",
      provider: "openai",
      apiKey: "sk-operator-upstream-secret",
      baseURL: `http://127.0.0.1:${upstream.port}/v1`,
      models: ["gpt-4o"],
    },
  ],
};

describe("SEC2-1 auth.keys without enabled keeps auth on", () => {
  it("schema does not default enabled to false", () => {
    const config = parseConfig({ ...base, auth: { keys: ["sk-client-key-1"] } }) as GatewayConfig;
    expect(config.auth?.enabled).not.toBe(false);
    expect(isClientAuthEnabled(config.auth)).toBe(true);
  });

  it("configuring client keys must not leave /v1 open", async () => {
    const { app } = await appFor({ ...base, auth: { keys: ["sk-client-key-1"] } });
    expect((await app.request("/v1/models")).status).toBe(401);
    const ok = await app.request("/v1/models", { headers: { Authorization: "Bearer sk-client-key-1" } });
    expect(ok.status).toBe(200);
  });

  it("anonymous proxy request must not reach upstream with the operator key", async () => {
    seenAuth = null;
    const { app } = await appFor({ ...base, auth: { keys: ["sk-client-key-1"] } });
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(seenAuth).toBeNull();
  });

  it("empty auth block keeps auth on", async () => {
    const { app } = await appFor({ ...base, auth: {} });
    expect((await app.request("/v1/models")).status).toBe(401);
  });

  it("explicit enabled: false still disables client auth", async () => {
    const { app } = await appFor({ ...base, auth: { enabled: false } });
    expect((await app.request("/v1/models")).status).toBe(200);
  });
});

describe("authExposureWarning", () => {
  it("warns when auth explicitly disabled on wildcard hosts", () => {
    for (const host of ["0.0.0.0", "::", "[::]", undefined]) {
      expect(authExposureWarning({ enabled: false }, host)).toContain("DISABLED");
    }
  });
  it("is silent for loopback or when auth is on / omitted", () => {
    expect(authExposureWarning({ enabled: false }, "127.0.0.1")).toBeUndefined();
    expect(authExposureWarning({ enabled: true }, "0.0.0.0")).toBeUndefined();
    expect(authExposureWarning({ keys: ["k"] } as { enabled?: boolean }, "0.0.0.0")).toBeUndefined();
    expect(authExposureWarning(undefined, "0.0.0.0")).toBeUndefined();
  });
});
