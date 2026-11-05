/**
 * Console sign-in (0.3.0 P6, plan §9.4): admin key → server-side session in an
 * HttpOnly SameSite=Strict cookie, double-submit CSRF on cookie writes, login
 * lockout, list / revoke / logout; Bearer access unchanged; /v1 never takes the
 * cookie. Plus the Playground route and the channel balance endpoint.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { adminHarness, FakeUpstreams, type Harness, yamlTarget } from "./_admin-harness.js";

const ups = new FakeUpstreams();
const FILE = { strategy: { mode: "fallback", targets: ["a"] }, targets: [yamlTarget("a", ["gpt-x"])] };

interface Signed {
  cookie: string;
  csrf: string;
  setCookies: string[];
  body: Record<string, unknown>;
}

async function login(h: Harness, key: string, opts: { url?: string; ip?: string } = {}): Promise<Response> {
  return h.app.request(opts.url ?? "/admin/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.ip ? { "x-test-ip": opts.ip } : {}) },
    body: JSON.stringify({ key }),
  });
}

async function signIn(h: Harness, key: string): Promise<Signed> {
  const res = await login(h, key);
  expect(res.status).toBe(200);
  const setCookies = res.headers.getSetCookie();
  const pairs = setCookies.map((c) => c.split(";")[0]!);
  const body = (await res.json()) as Record<string, unknown>;
  return { cookie: pairs.join("; "), csrf: String(body["csrfToken"]), setCookies, body };
}

function withSession(
  h: Harness,
  s: Signed,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return h.app.request(`/admin${path}`, {
    method,
    headers: {
      cookie: s.cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("console session auth", () => {
  let h: Harness;
  beforeAll(async () => {
    ups.install();
    h = await adminHarness(FILE);
  });
  afterAll(() => ups.uninstall());
  afterEach(() => ups.reset());

  it("login sets an HttpOnly SameSite=Strict session cookie and a readable CSRF cookie; the key is never echoed", async () => {
    const s = await signIn(h, h.keys.admin);
    const session = s.setCookies.find((c) => c.startsWith("aigw_session="))!;
    const csrf = s.setCookies.find((c) => c.startsWith("aigw_csrf="))!;
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Strict");
    expect(session).toContain("Path=/admin");
    expect(session).toContain("Max-Age=43200");
    expect(session).not.toContain("Secure"); // plain http
    expect(csrf).not.toContain("HttpOnly");
    expect(csrf).toContain("SameSite=Strict");
    expect(csrf.split(";")[0]).toBe(`aigw_csrf=${s.csrf}`);
    expect(JSON.stringify(s.body)).not.toContain(h.keys.admin);
    expect(s.body["scopes"]).toEqual(["admin"]);
    expect(String(s.body["actor"])).toMatch(/^key:/);
  });

  it("Secure on https and behind a proxy saying X-Forwarded-Proto: https", async () => {
    const a = await login(h, h.keys.admin, { url: "https://gw.example/admin/session/login" });
    expect(a.headers.getSetCookie().every((c) => c.includes("Secure"))).toBe(true);
    const b = await h.app.request("/admin/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ key: h.keys.admin }),
    });
    expect(b.headers.getSetCookie().every((c) => c.includes("Secure"))).toBe(true);
  });

  it("the cookie authenticates reads; writes need the CSRF header matching cookie and session", async () => {
    const s = await signIn(h, h.keys.admin);
    expect((await withSession(h, s, "GET", "/status")).status).toBe(200);
    const info = (await (await withSession(h, s, "GET", "/session")).json()) as Record<string, unknown>;
    expect(info["via"]).toBe("session");
    expect(info["csrfToken"]).toBe(s.csrf);

    const body = { name: "s1", scopes: ["inference"] };
    const none = await withSession(h, s, "POST", "/keys", body);
    expect(none.status).toBe(403);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("csrf_token_invalid");
    expect((await withSession(h, s, "POST", "/keys", body, { "x-csrf-token": "wrong" })).status).toBe(403);
    // Header right but the CSRF cookie missing (only the session cookie sent).
    const onlySession = s.cookie
      .split("; ")
      .filter((p) => p.startsWith("aigw_session="))
      .join("; ");
    expect(
      (
        await h.app.request("/admin/keys", {
          method: "POST",
          headers: { cookie: onlySession, "content-type": "application/json", "x-csrf-token": s.csrf },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    const ok = await withSession(h, s, "POST", "/keys", body, { "x-csrf-token": s.csrf });
    expect(ok.status).toBe(201);
    // The audit records the session's key as the actor.
    const audit = (await (await withSession(h, s, "GET", "/audit")).json()) as {
      data: Array<{ actor: string; action: string }>;
    };
    expect(audit.data.find((a) => a.action === "key_create")?.actor).toBe(String(s.body["actor"]));
  });

  it("the P4 guards still apply to cookie writes: cross-site and non-JSON are refused", async () => {
    const s = await signIn(h, h.keys.admin);
    const csrf = { "x-csrf-token": s.csrf };
    expect(
      (await withSession(h, s, "POST", "/keys", { name: "x" }, { ...csrf, "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(
      (await withSession(h, s, "POST", "/keys", { name: "x" }, { ...csrf, origin: "https://evil.example" })).status,
    ).toBe(403);
    const form = await h.app.request("/admin/keys", {
      method: "POST",
      headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", ...csrf },
      body: "name=x",
    });
    expect(form.status).toBe(415);
  });

  it("a cross-site login form post is refused", async () => {
    const res = await h.app.request("/admin/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ key: h.keys.admin }),
    });
    expect(res.status).toBe(403);
  });

  it("read_only sessions read but cannot write", async () => {
    const s = await signIn(h, h.keys.readOnly);
    expect((await withSession(h, s, "GET", "/channels")).status).toBe(200);
    expect((await withSession(h, s, "POST", "/keys", { name: "x" }, { "x-csrf-token": s.csrf })).status).toBe(403);
  });

  it("bad key 401, inference key 403; no session is created", async () => {
    const bad = await login(h, "sk-nope");
    expect(bad.status).toBe(401);
    expect(bad.headers.getSetCookie()).toEqual([]);
    const inf = await login(h, h.keys.inference);
    expect(inf.status).toBe(403);
    expect(inf.headers.getSetCookie()).toEqual([]);
    expect((await login(h, "")).status).toBe(400);
  });

  it("a session ends when its key is revoked", async () => {
    const created = await h.admin("POST", "/keys", { name: "temp-admin", scopes: ["admin"] });
    const { id, key } = (await created.json()) as { id: string; key: string };
    const s = await signIn(h, key);
    expect((await withSession(h, s, "GET", "/status")).status).toBe(200);
    expect((await h.admin("POST", `/keys/${id}/revoke`, {})).status).toBe(200);
    const after = await withSession(h, s, "GET", "/status");
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe("session_expired");
    expect(after.headers.getSetCookie().some((c) => c.startsWith("aigw_session=;") && c.includes("Max-Age=0"))).toBe(
      true,
    );
  });

  it("RA4: rotating a key ends the sessions it opened (and only those); the new secret signs in", async () => {
    const created = await h.admin("POST", "/keys", { name: "rotated-admin", scopes: ["admin"] });
    const { id, key } = (await created.json()) as { id: string; key: string };
    const s1 = await signIn(h, key);
    const s2 = await signIn(h, key);
    const other = await signIn(h, h.keys.admin);
    expect((await h.app.request("/admin/sessions", { headers: { cookie: s1.cookie } })).status).toBe(200);
    const rot = await h.admin("POST", `/keys/${id}/rotate`, {});
    expect(rot.status).toBe(200);
    const fresh = ((await rot.json()) as { key: string }).key;
    for (const s of [s1, s2]) {
      const after = await withSession(h, s, "GET", "/status");
      expect(after.status).toBe(401); // was 200: rotate left the sessions of the old secret alive
      expect(((await after.json()) as { error: { code: string } }).error.code).toBe("session_expired");
    }
    expect((await withSession(h, other, "GET", "/status")).status).toBe(200);
    expect((await login(h, key)).status).toBe(401);
    const s3 = await signIn(h, fresh);
    expect((await withSession(h, s3, "GET", "/status")).status).toBe(200);
    const audit = (await (await h.admin("GET", "/audit")).json()) as {
      data: Array<{ action: string; detail: Record<string, unknown> | null }>;
    };
    expect(audit.data.find((a) => a.action === "key_rotate")?.detail).toMatchObject({ sessionsEnded: 2 });

    // A rotation outside this process (the CLI on the same database) also ends the session, on its next request.
    h.keyStore.rotateKey(id);
    expect((await withSession(h, s3, "GET", "/status")).status).toBe(401);
  });

  it("logout ends the session (CSRF required)", async () => {
    const s = await signIn(h, h.keys.admin);
    expect((await withSession(h, s, "POST", "/session/logout")).status).toBe(403);
    const out = await withSession(h, s, "POST", "/session/logout", undefined, { "x-csrf-token": s.csrf });
    expect(out.status).toBe(204);
    expect((await withSession(h, s, "GET", "/status")).status).toBe(401);
  });

  it("sessions are listed and can be revoked; a read_only session cannot revoke another", async () => {
    const a = await signIn(h, h.keys.admin);
    const r = await signIn(h, h.keys.readOnly);
    const list = (await (await withSession(h, a, "GET", "/sessions")).json()) as {
      data: Array<{ id: string; current: boolean; actor: string }>;
    };
    const mine = list.data.find((x) => x.current)!;
    expect(mine.id).toBe(String(a.body["sessionId"]));
    expect(JSON.stringify(list)).not.toContain(a.csrf);
    expect(
      (await withSession(h, r, "DELETE", `/sessions/${mine.id}`, undefined, { "x-csrf-token": r.csrf })).status,
    ).toBe(403);
    const roId = String(r.body["sessionId"]);
    expect((await withSession(h, a, "DELETE", `/sessions/${roId}`, undefined, { "x-csrf-token": a.csrf })).status).toBe(
      204,
    );
    expect((await withSession(h, r, "GET", "/status")).status).toBe(401);
    expect(
      (await withSession(h, a, "DELETE", "/sessions/ses_nope", undefined, { "x-csrf-token": a.csrf })).status,
    ).toBe(404);
  });

  it("Bearer access is unchanged and ignores cookies; /v1 never accepts the session cookie", async () => {
    const s = await signIn(h, h.keys.admin);
    // A Bearer header wins: a bad Bearer with a good cookie is 401.
    const bad = await h.app.request("/admin/status", {
      headers: { cookie: s.cookie, authorization: "Bearer sk-nope" },
    });
    expect(bad.status).toBe(401);
    // Bearer writes need no CSRF token.
    expect((await h.admin("POST", "/keys", { name: "bearer-made" })).status).toBe(201);
    const v1 = await h.app.request("/v1/models", { headers: { cookie: s.cookie } });
    expect(v1.status).toBe(401);
  });

  it("an unknown or forged cookie is 401", async () => {
    const res = await h.app.request("/admin/status", { headers: { cookie: "aigw_session=forged" } });
    expect(res.status).toBe(401);
  });
});

describe("console login lockout", () => {
  it("5 failures lock the client out (429 + Retry-After) even for the right key", async () => {
    const h = await adminHarness(FILE);
    for (let i = 0; i < 4; i++) expect((await login(h, `sk-wrong-${i}`)).status).toBe(401);
    expect((await login(h, "sk-wrong-last")).status).toBe(401);
    const locked = await login(h, h.keys.admin);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(800);
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe("login_locked");
    const audit = (await (await h.admin("GET", "/audit")).json()) as {
      data: Array<{ action: string; detail: unknown }>;
    };
    const failures = audit.data.filter((a) => a.action === "console_login_failed");
    expect(failures.length).toBe(5);
    expect(JSON.stringify(failures)).not.toContain("sk-wrong");
  });
});

/** A login from a given TCP peer address (Bun's server.requestIP), with optional extra headers. */
async function loginFrom(
  h: Harness,
  key: string,
  peer: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return h.app.request(
    "/admin/session/login",
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ key }) },
    { requestIP: () => ({ address: peer, family: peer.includes(":") ? "IPv6" : "IPv4", port: 40000 }) },
  );
}

describe("console login: no global lockout, no spoofable client IP (red team RA1 / RA2)", () => {
  it("RA1: 62 failures from 62 IPs (over the old global cap) do not lock the admin out of a fresh IP", async () => {
    const h = await adminHarness(FILE);
    for (let i = 0; i < 62; i++) {
      expect((await loginFrom(h, "sk-wrong-flood", `203.0.113.${i + 1}`)).status).toBe(401);
    }
    const t0 = Date.now();
    const ok = await loginFrom(h, h.keys.admin, "198.51.100.77");
    expect(ok.status).toBe(200); // was 429 login_locked for everyone
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450); // slowed down (500 ms at 1× the threshold), not refused
    // The per-IP lockout still holds.
    for (let i = 0; i < 5; i++) await loginFrom(h, "sk-wrong", "192.0.2.10");
    expect((await loginFrom(h, h.keys.admin, "192.0.2.10")).status).toBe(429);
  });

  it("RA2: by default X-Forwarded-For from a loopback peer is ignored: no lockout bypass, no victim lockout", async () => {
    const h = await adminHarness(FILE);
    // Rotating the spoofed XFF does not give 5 fresh "IPs": the peer (127.0.0.1) is locked after 5.
    for (let i = 0; i < 5; i++) {
      expect((await loginFrom(h, "sk-wrong", "127.0.0.1", { "x-forwarded-for": `203.0.113.${i + 1}` })).status).toBe(
        401,
      );
    }
    expect((await loginFrom(h, h.keys.admin, "127.0.0.1", { "x-forwarded-for": "203.0.113.99" })).status).toBe(429);
    // Those attempts named 198.51.100.200 nowhere; and spoofing a victim's IP does not lock the victim out.
    const h2 = await adminHarness(FILE);
    for (let i = 0; i < 6; i++)
      await loginFrom(h2, "sk-wrong", "203.0.113.50", { "x-forwarded-for": "198.51.100.200" });
    expect((await loginFrom(h2, h2.keys.admin, "198.51.100.200")).status).toBe(200);
  });
});

describe("console playground and channel balance", () => {
  let h: Harness;
  beforeAll(async () => {
    ups.install();
    h = await adminHarness(FILE);
  });
  afterAll(() => ups.uninstall());
  afterEach(() => ups.reset());

  it("playground calls a published model through the real routing (stream and not), admin only", async () => {
    const s = await signIn(h, h.keys.admin);
    const csrf = { "x-csrf-token": s.csrf };
    const plain = await withSession(
      h,
      s,
      "POST",
      "/playground/chat/completions",
      { model: "gpt-x", messages: [{ role: "user", content: "hi" }] },
      csrf,
    );
    expect(plain.status).toBe(200);
    expect(
      ((await plain.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content,
    ).toBe("a:gpt-x");
    const streamed = await withSession(
      h,
      s,
      "POST",
      "/playground/chat/completions",
      { model: "gpt-x", stream: true, messages: [{ role: "user", content: "hi" }] },
      csrf,
    );
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const text = await streamed.text();
    expect(text).toContain("a:gpt-x");
    expect(text).toContain("[DONE]");
    // Unpublished models are refused like any client request.
    expect(
      (
        await withSession(
          h,
          s,
          "POST",
          "/playground/chat/completions",
          { model: "nope", messages: [{ role: "user", content: "x" }] },
          csrf,
        )
      ).status,
    ).toBe(404);
    const ro = await signIn(h, h.keys.readOnly);
    expect(
      (
        await withSession(
          h,
          ro,
          "POST",
          "/playground/chat/completions",
          { model: "gpt-x", messages: [] },
          { "x-csrf-token": ro.csrf },
        )
      ).status,
    ).toBe(403);
  });

  async function channel(preset: string, host: string): Promise<string> {
    const res = await h.admin("POST", "/channels", {
      name: `${preset}-${host.split(".")[0]}`,
      preset,
      baseURL: `https://${host}/${preset === "openrouter" ? "api/v1" : "v1"}`,
      keys: [{ key: `sk-${preset}-secret-123456` }],
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("DeepSeek: GET /user/balance with the channel key; values passed through, nothing stored", async () => {
    const id = await channel("deepseek", "ds.upstream.test");
    ups.enqueue("ds.upstream.test", {
      status: 200,
      body: {
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
        ],
      },
    });
    const before = (await (await h.admin("GET", "/config/versions")).json()) as { head: number };
    const res = await h.admin("GET", `/channels/${id}/balance`, undefined, { key: h.keys.readOnly });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      supported: true,
      ok: true,
      available: true,
      balances: [{ currency: "CNY", total: "110.00" }],
    });
    expect(JSON.stringify(body)).not.toContain("sk-deepseek-secret");
    const call = ups.hits("ds.upstream.test")[0]!;
    expect(call.path).toBe("/user/balance");
    expect(call.auth).toBe("Bearer sk-deepseek-secret-123456");
    const after = (await (await h.admin("GET", "/config/versions")).json()) as { head: number };
    expect(after.head).toBe(before.head);
  });

  it("OpenRouter: /credits → remaining credits", async () => {
    const id = await channel("openrouter", "or.upstream.test");
    ups.enqueue("or.upstream.test", { status: 200, body: { data: { total_credits: 20, total_usage: 7.5 } } });
    const body = (await (await h.admin("GET", `/channels/${id}/balance`)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, balances: [{ currency: "USD", total: "12.5" }] });
    expect(ups.hits("or.upstream.test")[0]!.path).toBe("/api/v1/credits");
  });

  it("upstream errors are reported without the key; unsupported presets say so without a call", async () => {
    const id = await channel("deepseek", "ds2.upstream.test");
    ups.enqueue("ds2.upstream.test", {
      status: 401,
      body: { error: { message: "bad key sk-deepseek-secret-123456" } },
    });
    const body = (await (await h.admin("GET", `/channels/${id}/balance`)).json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(JSON.stringify(body)).not.toContain("sk-deepseek-secret-123456");

    const other = await channel("openai", "oa.upstream.test");
    const res = await h.admin("GET", `/channels/${other}/balance`);
    expect(await res.json()).toEqual({ channelId: other, supported: false });
    expect(ups.hits("oa.upstream.test")).toEqual([]);
    expect((await h.admin("GET", "/channels/ch_nope/balance")).status).toBe(404);
  });

  it("a malformed balance answer is not passed through", async () => {
    const id = await channel("deepseek", "ds3.upstream.test");
    ups.enqueue("ds3.upstream.test", {
      status: 200,
      body: { balance_infos: [{ currency: "<script>", total_balance: "1e309x" }] },
    });
    const body = (await (await h.admin("GET", `/channels/${id}/balance`)).json()) as Record<string, unknown>;
    expect(body["balances"]).toEqual([]);
  });
});
