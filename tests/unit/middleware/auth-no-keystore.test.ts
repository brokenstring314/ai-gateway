// Regression (R3-H1 / S3-1): createApp() without a KeyStore — the README
// "Embedded Mode" call `createApp(gateway, config)` and formerly the
// `ai-gateway serve` CLI — installed no client auth at all, so /v1/* was open
// to anonymous callers even with auth.enabled: true + auth.keys.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { clientCredentialWarning } from "@/index";
import { KeyStore } from "@/persistence/key-store";
import type { GatewayConfig } from "@/config/types";

function cfg(extra: Record<string, unknown> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["t"] },
    targets: [{ name: "t", provider: "openai", apiKey: "sk-OPERATOR", baseURL: "https://up.example/v1", models: ["gpt-4o"] }],
    ...extra,
  } as unknown as GatewayConfig;
}
const okChat = () => new Response(JSON.stringify({
  id: "c", object: "chat.completion", created: 1, model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { status: 200, headers: { "content-type": "application/json" } });

function chat(app: ReturnType<typeof createApp>, auth?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== undefined) headers["authorization"] = auth;
  return app.request("/v1/chat/completions", {
    method: "POST", headers,
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
  });
}

let fetchSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => okChat()) as unknown as typeof fetch);
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { fetchSpy.mockRestore(); errSpy.mockRestore(); });

describe("createApp without a KeyStore enforces client auth", () => {
  it("auth.enabled + auth.keys: anonymous and wrong key → 401, upstream untouched", async () => {
    const c = cfg({ auth: { enabled: true, keys: ["client-key-1"] } });
    const app = createApp(new Gateway(c), c);
    expect((await chat(app)).status).toBe(401);
    expect((await chat(app, "Bearer WRONG")).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("auth.enabled + auth.keys: a configured key → 200", async () => {
    const c = cfg({ auth: { enabled: true, keys: ["client-key-1"] } });
    const app = createApp(new Gateway(c), c);
    expect((await chat(app, "Bearer client-key-1")).status).toBe(200);
  });

  it("auth block omitted (auth on by default) → 401", async () => {
    const c = cfg();
    const app = createApp(new Gateway(c), c);
    expect((await chat(app, "Bearer anything")).status).toBe(401);
  });

  it("auth enabled with no keys and no store → fail closed (401) and logs an error", async () => {
    const c = cfg({ auth: { enabled: true, keys: [] } });
    const app = createApp(new Gateway(c), c);
    expect((await chat(app)).status).toBe(401);
    expect((await chat(app, "Bearer x")).status).toBe(401);
    expect(errSpy).toHaveBeenCalled();
  });

  it("only explicit auth.enabled: false disables client auth", async () => {
    const c = cfg({ auth: { enabled: false } });
    const app = createApp(new Gateway(c), c);
    expect((await chat(app)).status).toBe(200);
  });

  it("with a KeyStore, auth.keys keep working alongside store keys", async () => {
    const ks = await KeyStore.create(new Database(":memory:"));
    const storeKey = ks.create("app", ["inference"]).key;
    const c = cfg({ auth: { enabled: true, keys: ["client-key-1"] } });
    const app = createApp(new Gateway(c), c, undefined, ks);
    expect((await chat(app, "Bearer client-key-1")).status).toBe(200);
    expect((await chat(app, `Bearer ${storeKey}`)).status).toBe(200);
    expect((await chat(app, "Bearer WRONG")).status).toBe(401);
  });

  it("pass-through proxy accepts auth.keys without a KeyStore", async () => {
    const c = cfg({ auth: { enabled: true, keys: ["client-key-1"] }, passthroughProxy: { enabled: true } });
    const app = createApp(new Gateway(c), c);
    const anon = await app.request("/v1/moderations?provider=t", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(anon.status).toBe(401);
    const ok = await app.request("/v1/moderations?provider=t", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer client-key-1" }, body: "{}" });
    expect(ok.status).not.toBe(401);
  });
});

describe("ai-gateway serve CLI uses the main bootstrap", () => {
  it("cli serve delegates to the shared bootstrap() (key store + auth), not a bare createApp", () => {
    const src = readFileSync(new URL("../../../src/cli/index.ts", import.meta.url), "utf-8");
    expect(src).toContain('await import("../server/bootstrap.js")');
    expect(src).not.toMatch(/createApp\(/);
  });
});

describe("clientCredentialWarning", () => {
  const empty = { isEmpty: () => true, hasActiveAdminKey: () => false };
  const full = { isEmpty: () => false, hasActiveAdminKey: () => true };
  it("warns when auth is on and nothing can authenticate", () => {
    expect(clientCredentialWarning(cfg(), empty, undefined)).toContain("no client keys");
  });
  it("warns that the bootstrap admin key is live while no admin credential exists", () => {
    const w = clientCredentialWarning(cfg(), empty, "boot");
    expect(w).toContain("ADMIN_BOOTSTRAP_KEY");
  });
  it("silent once an admin credential exists, or auth is off with nothing to warn about", () => {
    expect(clientCredentialWarning(cfg(), full, "boot")).toBeUndefined();
    expect(clientCredentialWarning(cfg({ auth: { keys: ["k"] } }), empty, "boot")).toBeUndefined();
    expect(clientCredentialWarning(cfg({ auth: { enabled: false } }), empty, undefined)).toBeUndefined();
    expect(clientCredentialWarning(cfg({ auth: { keys: ["k"] } }), empty, undefined)).toBeUndefined();
  });
});
