/**
 * Final red team 2026-11-06 (authentication / admin surface):
 *
 * FA-1: /admin answered CORS `*` and its preflight approved X-Admin-Secret for
 * every origin, and the per-IP failure counting ran before the cross-site
 * check: any web page the admin opened could send 5 bad credentials and lock
 * the admin's IP out of the console sign-in and every header credential for
 * 15 minutes (repros/auth/fa_cors_lockout.sh).
 *
 * FA-2: a successful console sign-in cleared the IP's failure counter, so a
 * read_only key holder guessed 4 times, signed in once, and repeated forever
 * (repros/auth/fa_ro_lockout_reset.sh: 60 wrong guesses, 0 lockouts).
 *
 * FA-3: the 64-slot session table evicted the least recently used session on
 * every sign-in, with no per-credential cap and no rate limit: 64 read_only
 * sign-ins signed every admin out (repros/auth/fa_session_evict.sh); every
 * sign-in also added an audit row, kept forever.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import { ConfigStore } from "@/persistence/config-store";
import { KeyStore } from "@/persistence/key-store";

const SECRET = "admin-secret-0123456789abcdef";

async function setup(extra: Record<string, unknown> = {}) {
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
    ...extra,
  });
  const store = await KeyStore.create(new Database(":memory:"));
  const readOnly = store.create("ro", ["read_only"]).key;
  const admin = store.create("adm", ["admin"]).key;
  const app = createApp(new Gateway(config), config, undefined, store, { adminSecret: SECRET });
  const peer = (ip: string) => ({ requestIP: () => ({ address: ip, family: "IPv4", port: 40000 }) });
  const req = (ip: string, path: string, init: RequestInit = {}) => app.request(path, init, peer(ip));
  const login = (ip: string, key: string, headers: Record<string, string> = {}) =>
    req(ip, "/admin/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ key }),
    });
  const cookieOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
  return { req, login, cookieOf, readOnly, admin };
}

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const EVIL = "https://evil.example";

describe("FA-1 no CORS on /admin; cross-site requests are refused before any credential is counted", () => {
  it("the browser preflight for X-Admin-Secret gets no Access-Control-* header (the real request is never sent)", async () => {
    const { req } = await setup();
    for (const path of ["/admin/status", "/admin/session/login", "/admin/keys", "/ADMIN/status", "//admin/status"]) {
      const r = await req("10.1.0.1", path, {
        method: "OPTIONS",
        headers: {
          origin: EVIL,
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-admin-secret",
        },
      });
      expect(r.headers.get("access-control-allow-origin")).toBeNull(); // was "*"
      expect(r.headers.get("access-control-allow-headers")).toBeNull(); // was "x-admin-secret"
    }
    // /v1 keeps its CORS.
    const v1 = await req("10.1.0.1", "/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        origin: EVIL,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization",
      },
    });
    expect(v1.headers.get("access-control-allow-origin")).toBe("*");
    // Admin responses carry no CORS header either.
    const st = await req("10.1.0.1", "/admin/status", { headers: { "x-admin-secret": SECRET, origin: EVIL } });
    expect(st.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("fa_cors_lockout repro: 50 cross-site bad credentials are 403 and never lock the admin's IP out", async () => {
    const { req, login, admin } = await setup();
    for (let i = 0; i < 25; i++) {
      const a = await req("10.1.1.1", "/admin/status", {
        headers: { "x-admin-secret": `x${i}`, origin: EVIL, "sec-fetch-site": "cross-site" },
      });
      expect(a.status).toBe(403); // was 401, then 429
      expect(await code(a)).toBe("csrf_rejected");
      const b = await req("10.1.1.1", "/admin/status", { headers: { authorization: `Bearer y${i}`, origin: EVIL } });
      expect(b.status).toBe(403);
    }
    // The real admin on the same IP: header credential and console sign-in both work (were 429 auth_locked / login_locked).
    expect((await req("10.1.1.1", "/admin/status", { headers: { "x-admin-secret": SECRET } })).status).toBe(200);
    expect((await login("10.1.1.1", admin)).status).toBe(200);
  });

  it('cross-site sign-in attempts are refused without counting, even with cors.origins: ["*"]', async () => {
    const { login, admin } = await setup({ cors: { origins: ["*"] } });
    for (let i = 0; i < 10; i++) {
      const r = await login("10.1.2.1", `wrong-${i}`, { "sec-fetch-site": "cross-site" });
      expect(r.status).toBe(403);
      const o = await login("10.1.2.1", `wrong-${i}`, { origin: EVIL });
      expect(o.status).toBe(403); // a "*" in cors.origins does not open the Admin API to every origin
    }
    expect((await login("10.1.2.1", admin)).status).toBe(200);
  });

  it("CLI / curl (no Origin, no Sec-Fetch-Site), same-origin and configured origins keep working; their failures still count", async () => {
    const { req } = await setup({ cors: { origins: ["https://ops.example"] } });
    expect((await req("10.1.3.1", "/admin/status", { headers: { "x-admin-secret": SECRET } })).status).toBe(200);
    expect(
      (
        await req("10.1.3.1", "http://localhost/admin/status", {
          headers: { "x-admin-secret": SECRET, origin: "http://localhost" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await req("10.1.3.1", "/admin/status", {
          headers: { "x-admin-secret": SECRET, origin: "https://ops.example", "sec-fetch-site": "same-site" },
        })
      ).status,
    ).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await req("10.1.3.2", "/admin/status", { headers: { "x-admin-secret": `bad-${i}` } })).status).toBe(401);
    }
    expect((await req("10.1.3.2", "/admin/status", { headers: { "x-admin-secret": SECRET } })).status).toBe(429);
  });
});

describe("FA-2 a successful console sign-in never clears the IP's failures", () => {
  it("fa_ro_lockout_reset repro: 4 guesses + 1 read_only sign-in, repeated, locks out after 5 failures", async () => {
    const { login, readOnly } = await setup();
    const statuses: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) statuses.push((await login("10.2.0.1", `guess-${round}-${i}`)).status);
      statuses.push((await login("10.2.0.1", readOnly)).status);
    }
    // 4 × 401, a 200, then the 5th failure locks: everything after is 429 (was 60 × 401, 0 × 429).
    expect(statuses.slice(0, 6)).toEqual([401, 401, 401, 401, 200, 401]);
    expect(statuses.slice(6).every((s) => s === 429)).toBe(true);
    const locked = await login("10.2.0.1", readOnly);
    expect(locked.status).toBe(429);
    expect(await code(locked)).toBe("login_locked");
  });

  it("the header path and the console share the same, non-resetting counter", async () => {
    const { req, login, readOnly } = await setup();
    for (let i = 0; i < 3; i++)
      expect((await req("10.2.1.1", "/admin/status", { headers: { "x-admin-secret": `g${i}` } })).status).toBe(401);
    expect((await login("10.2.1.1", readOnly)).status).toBe(200);
    expect((await login("10.2.1.1", "nope-1")).status).toBe(401);
    expect((await req("10.2.1.1", "/admin/status", { headers: { "x-admin-secret": "g9" } })).status).toBe(401);
    expect((await req("10.2.1.1", "/admin/status", { headers: { "x-admin-secret": SECRET } })).status).toBe(429);
  });
});

describe("FA-3 a read_only key cannot sign admins out; sign-ins are capped per credential and rate limited", () => {
  it("fa_session_evict repro: 64 read_only sign-ins leave the admin's console session alive", async () => {
    const { req, login, cookieOf, readOnly, admin } = await setup({ console: { maxLoginsPerMinute: 1000 } });
    const a = await login("10.3.0.1", admin);
    expect(a.status).toBe(200);
    const adminCookie = cookieOf(a);
    for (let i = 0; i < 64; i++) expect((await login(`10.3.1.${i}`, readOnly)).status).toBe(200);
    const after = await req("10.3.0.1", "/admin/session", { headers: { cookie: adminCookie } });
    expect(after.status).toBe(200); // was 401 session_expired
    // read_only holds at most 5 sessions (its own oldest are ended).
    const list = (await (await req("10.3.0.1", "/admin/sessions", { headers: { cookie: adminCookie } })).json()) as {
      data: Array<{ scopes: string[] }>;
    };
    expect(list.data.filter((s) => s.scopes.includes("read_only")).length).toBe(5);
    expect(list.data.length).toBe(6);
  });

  it("a full table of other credentials refuses a read_only sign-in with 503 session_limit instead of evicting", async () => {
    const config = { console: { maxLoginsPerMinute: 1000, maxSessionsPerCredential: 1 } };
    const s = await setup(config);
    // Fill the table with 64 distinct admin credentials through the key API.
    const keys: string[] = [];
    for (let i = 0; i < 64; i++) {
      const r = await s.req("10.3.2.1", "/admin/keys", {
        method: "POST",
        headers: { "x-admin-secret": SECRET, "content-type": "application/json" },
        body: JSON.stringify({ name: `adm-${i}`, scopes: ["admin"] }),
      });
      expect(r.status).toBe(201);
      keys.push(((await r.json()) as { key: string }).key);
    }
    const cookies: string[] = [];
    for (const k of keys) {
      const r = await s.login("10.3.2.2", k);
      expect(r.status).toBe(200);
      cookies.push(s.cookieOf(r));
    }
    const refused = await s.login("10.3.2.3", s.readOnly);
    expect(refused.status).toBe(503);
    expect(await code(refused)).toBe("session_limit");
    expect(refused.headers.get("retry-after")).toBe("60");
    for (const c of cookies)
      expect((await s.req("10.3.2.2", "/admin/session", { headers: { cookie: c } })).status).toBe(200);
  });

  it("successful sign-ins are limited per client IP (default 20 a minute): 429 login_rate_limited", async () => {
    const { login, readOnly, admin } = await setup();
    for (let i = 0; i < 20; i++) expect((await login("10.3.3.1", readOnly)).status).toBe(200);
    const r = await login("10.3.3.1", readOnly);
    expect(r.status).toBe(429);
    expect(await code(r)).toBe("login_rate_limited");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login("10.3.3.2", admin)).status).toBe(200); // other IPs unaffected
  });

  it("the audit log is pruned off the request path: row cap and age", async () => {
    const store = await ConfigStore.create(new Database(":memory:"), undefined);
    for (let i = 0; i < 300; i++)
      store.auditOnly("key:ro", "console_login", "console_session", `ses_${i}`, { ip: "x" });
    store.startAuditRetention({ maxRows: 100, retentionDays: 90 });
    expect(store.listAudit(500).length).toBe(300); // nothing pruned synchronously
    await Bun.sleep(20);
    const rows = store.listAudit(500);
    expect(rows.length).toBe(100);
    expect(rows[0]!.resourceId).toBe("ses_299"); // the newest are kept
    // Age: a step 91 days in the future removes everything older than 90 days.
    expect(store.pruneAuditStep(5000, Date.now() + 91 * 86_400_000)).toBe(100);
    store.close();
  });
});
