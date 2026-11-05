/**
 * Red team 2026-11-05 P4: the console sign-in had a per-IP lockout, but the
 * header credentials on /admin/* (X-Admin-Secret, Authorization: Bearer) had
 * no failure limiting at all: a client already locked out of the console
 * guessed adminSecret at ~10,000/s and a valid secret still answered 200
 * (repros/perimeter/t_bruteforce.ts).
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import { KeyStore } from "@/persistence/key-store";

const SECRET = "weakpass1-but-long-enough";

async function setup() {
  const config = loadConfigFromObject({
    strategy: { mode: "single" },
    targets: [
      {
        name: "a",
        provider: "openai",
        apiKey: "sk-a-0123456789",
        baseURL: "https://a.upstream.test/v1",
        models: ["m"],
      },
    ],
    adminSecret: SECRET,
    auth: { enabled: true },
  });
  const store = await KeyStore.create(new Database(":memory:"));
  const readOnly = store.create("ro", ["read_only"]).key;
  const inference = store.create("inf", ["inference"]).key;
  const app = createApp(new Gateway(config), config, undefined, store, { adminSecret: SECRET });
  const from = (ip: string, headers: Record<string, string>, path = "/admin/status") =>
    app.request(path, { headers }, { requestIP: () => ({ address: ip, family: "IPv4", port: 40000 }) });
  const login = (ip: string, key: string) =>
    app.request(
      "/admin/session/login",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) },
      { requestIP: () => ({ address: ip, family: "IPv4", port: 40000 }) },
    );
  return { from, login, readOnly, inference };
}

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

describe("P4 header admin credentials share the console's failure lockout", () => {
  it("t_bruteforce repro: 5 wrong X-Admin-Secret lock the IP out, even for the right secret; other IPs unaffected", async () => {
    const { from } = await setup();
    for (let i = 0; i < 5; i++) expect((await from("10.0.0.1", { "x-admin-secret": `guess-${i}` })).status).toBe(401);
    const locked = await from("10.0.0.1", { "x-admin-secret": SECRET }); // was 200
    expect(locked.status).toBe(429);
    expect(await code(locked)).toBe("auth_locked");
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(800);
    // 3,000 more guesses get nothing but 429 (no credential is checked).
    const statuses = new Set<number>();
    for (let i = 0; i < 300; i++) statuses.add((await from("10.0.0.1", { "x-admin-secret": `g${i}` })).status);
    expect([...statuses]).toEqual([429]);
    expect((await from("10.0.0.2", { "x-admin-secret": SECRET })).status).toBe(200);
  });

  it("wrong Bearer tokens count the same way", async () => {
    const { from } = await setup();
    for (let i = 0; i < 5; i++)
      expect((await from("10.0.1.1", { authorization: `Bearer nope-${i}` })).status).toBe(401);
    expect((await from("10.0.1.1", { authorization: `Bearer ${SECRET}` })).status).toBe(429);
  });

  it("requests without credentials and valid keys without the scope are not counted", async () => {
    const { from, inference } = await setup();
    for (let i = 0; i < 10; i++) {
      expect((await from("10.0.2.1", {})).status).toBe(401);
      expect((await from("10.0.2.1", { authorization: `Bearer ${inference}` })).status).toBe(403);
    }
    expect((await from("10.0.2.1", { "x-admin-secret": SECRET })).status).toBe(200);
  });

  it("a valid read_only key does not reset the failure count (no interleaving around the limit)", async () => {
    const { from, readOnly } = await setup();
    for (let i = 0; i < 4; i++) {
      expect((await from("10.0.3.1", { "x-admin-secret": `guess-${i}` })).status).toBe(401);
      expect((await from("10.0.3.1", { authorization: `Bearer ${readOnly}` })).status).toBe(200);
    }
    expect((await from("10.0.3.1", { "x-admin-secret": "guess-last" })).status).toBe(401);
    expect((await from("10.0.3.1", { authorization: `Bearer ${readOnly}` })).status).toBe(429);
  });

  it("console and header failures share one counter per IP", async () => {
    const { from, login } = await setup();
    for (let i = 0; i < 3; i++) expect((await from("10.0.4.1", { "x-admin-secret": `g${i}` })).status).toBe(401);
    for (let i = 0; i < 2; i++) expect((await login("10.0.4.1", `wrong-${i}`)).status).toBe(401);
    expect((await from("10.0.4.1", { "x-admin-secret": SECRET })).status).toBe(429);
    const viaConsole = await login("10.0.4.1", SECRET);
    expect(viaConsole.status).toBe(429);
    expect(await code(viaConsole)).toBe("login_locked");
  });
});
