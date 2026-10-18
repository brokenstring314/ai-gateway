// Regression (R3-H2 / S3-2): keys minted without scopes were ADMIN, and
// invalid scopes (e.g. [1]) were silently dropped → [] → admin. A key minted
// "for an app" could then mint more admin keys and rewrite config.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { KeyStore } from "@/persistence/key-store";
import type { GatewayConfig } from "@/config/types";

const SECRET = "admin-secret-0123456789";
const config = {
  adminSecret: SECRET,
  auth: { enabled: true },
  strategy: { mode: "single", targets: ["t"] },
  targets: [{ name: "t", provider: "openai", apiKey: "sk-OP", baseURL: "https://up.example/v1", models: ["gpt-4o"] }],
} as unknown as GatewayConfig;

let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(JSON.stringify({
    id: "c", object: "chat.completion", created: 1, model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
});
afterEach(() => fetchSpy.mockRestore());

async function setup() {
  const ks = await KeyStore.create(new Database(":memory:"));
  const app = createApp(new Gateway(config), config, undefined, ks, { adminSecret: SECRET });
  const admin = (method: string, path: string, body?: unknown, auth: Record<string, string> = { "x-admin-secret": SECRET }) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...auth }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, ks, admin };
}

describe("key scopes: least privilege by default, strict validation", () => {
  it("a key created with only a name gets ['inference'], not admin", async () => {
    const { admin } = await setup();
    const r = await admin("POST", "/admin/keys", { name: "mobile-app" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { scopes: string[] }).scopes).toEqual(["inference"]);
  });

  it("scopes: [] also defaults to inference", async () => {
    const { admin } = await setup();
    const r = await admin("POST", "/admin/keys", { name: "x", scopes: [] });
    expect(((await r.json()) as { scopes: string[] }).scopes).toEqual(["inference"]);
  });

  for (const scopes of [[1], [1, 2], ["admin", 1], ["superuser"], ["ADMIN"], "admin", { admin: true }, null]) {
    it(`create rejects scopes=${JSON.stringify(scopes)} with 400`, async () => {
      const { admin, ks } = await setup();
      const r = await admin("POST", "/admin/keys", { name: "x", scopes });
      expect(r.status).toBe(400);
      expect(ks.isEmpty()).toBe(true);
    });
  }

  it("update rejects invalid scopes with 400 and leaves the key unchanged", async () => {
    const { admin, ks } = await setup();
    const k = ks.create("k", ["inference"]);
    for (const scopes of [[1], ["root"], "admin"]) {
      const r = await admin("PUT", `/admin/keys/${k.id}`, { scopes });
      expect(r.status).toBe(400);
    }
    expect(ks.get(k.id)?.scopes).toEqual(["inference"]);
  });

  it("explicit admin / read_only scopes are still honored", async () => {
    const { admin } = await setup();
    const r = await admin("POST", "/admin/keys", { name: "ops", scopes: ["admin", "read_only"] });
    expect(((await r.json()) as { scopes: string[] }).scopes).toEqual(["admin", "read_only"]);
  });

  it("an inference key works on /v1 but gets 403 on every /admin route", async () => {
    const { app, admin } = await setup();
    const appKey = ((await (await admin("POST", "/admin/keys", { name: "mobile-app" })).json()) as { key: string }).key;
    const auth = { authorization: `Bearer ${appKey}` };
    const v1 = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(v1.status).toBe(200);
    expect((await admin("POST", "/admin/keys", { name: "attacker" }, auth)).status).toBe(403);
    expect((await admin("GET", "/admin/keys", undefined, auth)).status).toBe(403);
    expect((await admin("GET", "/admin/config", undefined, auth)).status).toBe(403);
    expect((await admin("PUT", "/admin/config", config, auth)).status).toBe(403);
    expect((await admin("DELETE", "/admin/logs", undefined, auth)).status).toBe(403);
  });

  it("a read_only key cannot mint keys", async () => {
    const { admin, ks } = await setup();
    const ro = ks.create("ro", ["read_only"]).key;
    expect((await admin("POST", "/admin/keys", { name: "x", scopes: ["admin"] }, { authorization: `Bearer ${ro}` })).status).toBe(403);
  });
});
