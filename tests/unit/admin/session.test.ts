// Console sessions (0.3.0 P6, plan §9.4): lifetime, idle timeout, CSRF token, login lockout.
import { describe, expect, it } from "bun:test";
import { cookieHeader, readCookie, SessionManager } from "@/admin/session";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const who = { actor: "key:k1", kind: "key" as const, keyId: "k1", scopes: ["admin"], ip: "1.2.3.4", userAgent: "ua" };

describe("SessionManager", () => {
  it("defaults: 12 h lifetime, 60 min idle, 5 failures, 15 min lockout", () => {
    const m = new SessionManager();
    expect(m.ttlMs).toBe(12 * 3600_000);
    expect(m.idleMs).toBe(60 * 60_000);
    expect(m.maxFailures).toBe(5);
    expect(m.lockoutMs).toBe(15 * 60_000);
  });

  it("a session is found by its cookie value only; the map never holds the value", () => {
    const m = new SessionManager();
    const { token, session } = m.create(who);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(session.hash).not.toContain(token);
    expect(JSON.stringify(m.list())).not.toContain(token);
    expect(JSON.stringify(m.list())).not.toContain(session.csrfToken);
    expect(m.touch(token)?.id).toBe(session.id);
    expect(m.touch(`${token}x`)).toBeUndefined();
    expect(m.touch("")).toBeUndefined();
    expect(m.touch(undefined)).toBeUndefined();
  });

  it("idle timeout ends a session; activity extends it up to the absolute lifetime", () => {
    const c = clock();
    const m = new SessionManager({ sessionTtlMinutes: 120, idleTimeoutMinutes: 30 }, c.now);
    const { token } = m.create(who);
    for (let i = 0; i < 3; i++) {
      c.advance(29 * 60_000);
      expect(m.touch(token)).toBeDefined();
    }
    c.advance(29 * 60_000); // 116 min
    expect(m.touch(token)).toBeDefined();
    c.advance(5 * 60_000); // 121 min: past the lifetime although active
    expect(m.touch(token)).toBeUndefined();

    const b = m.create(who);
    c.advance(30 * 60_000);
    expect(m.touch(b.token)).toBeUndefined();
  });

  it("CSRF: header and cookie must both equal the session token", () => {
    const m = new SessionManager();
    const { session } = m.create(who);
    const tok = session.csrfToken;
    expect(m.csrfValid(session, tok, tok)).toBe(true);
    expect(m.csrfValid(session, tok, undefined)).toBe(false);
    expect(m.csrfValid(session, undefined, tok)).toBe(false);
    expect(m.csrfValid(session, `${tok}a`, tok)).toBe(false);
    expect(m.csrfValid(session, tok, "x")).toBe(false);
    expect(m.csrfValid(session, "", "")).toBe(false);
    const other = m.create(who).session;
    expect(m.csrfValid(session, other.csrfToken, other.csrfToken)).toBe(false);
  });

  it("locks a client IP out after maxLoginFailures, for lockoutMinutes; other IPs are unaffected", () => {
    const c = clock();
    const m = new SessionManager({ maxLoginFailures: 3, lockoutMinutes: 10 }, c.now);
    expect(m.loginFailed("a")).toBe(false);
    expect(m.loginFailed("a")).toBe(false);
    expect(m.loginBlocked("a")).toBeUndefined();
    expect(m.loginFailed("a")).toBe(true);
    expect(m.loginBlocked("a")).toBe(600);
    expect(m.loginBlocked("b")).toBeUndefined();
    c.advance(9 * 60_000);
    expect(m.loginBlocked("a")).toBe(60);
    c.advance(60_000);
    expect(m.loginBlocked("a")).toBeUndefined();
  });

  it("a success clears the failure count", () => {
    const m = new SessionManager({ maxLoginFailures: 2 });
    m.loginFailed("a");
    m.loginSucceeded("a");
    expect(m.loginFailed("a")).toBe(false);
  });

  it("RA1: many failures overall slow sign-ins down (≤ 2 s) but never lock out a fresh IP", () => {
    const c = clock();
    const m = new SessionManager({ maxLoginFailures: 100 }, c.now);
    for (let i = 0; i < 59; i++) m.loginFailed(`ip${i}`);
    expect(m.loginDelayMs()).toBe(0);
    m.loginFailed("ip59");
    expect(m.loginBlocked("fresh")).toBeUndefined(); // was a 429 for everyone (global lockout)
    expect(m.loginDelayMs()).toBe(500);
    for (let i = 0; i < 1000; i++) m.loginFailed(`flood${i}`);
    expect(m.loginBlocked("fresh")).toBeUndefined();
    expect(m.loginDelayMs()).toBe(2000); // capped
    c.advance(60_000);
    expect(m.loginDelayMs()).toBe(0);
  });

  it("revoke by public id, end, and eviction of the least recently used beyond the cap", () => {
    const c = clock();
    const m = new SessionManager({}, c.now);
    const first = m.create(who);
    c.advance(1);
    const tokens: string[] = [];
    for (let i = 0; i < 63; i++) {
      tokens.push(m.create(who).token);
      c.advance(1);
    }
    expect(m.size).toBe(64);
    m.create(who); // evicts `first`, the least recently seen
    expect(m.touch(first.token)).toBeUndefined();
    expect(m.size).toBe(64);
    const s = m.touch(tokens[0]!)!;
    expect(m.revoke(s.id)).toBe(true);
    expect(m.revoke(s.id)).toBe(false);
    expect(m.touch(tokens[0]!)).toBeUndefined();
  });
});

describe("cookies", () => {
  it("serialize with Path=/admin, SameSite=Strict, HttpOnly and Secure as asked", () => {
    expect(cookieHeader("a", "v", { httpOnly: true, secure: true, maxAgeSeconds: 60 })).toBe(
      "a=v; Path=/admin; SameSite=Strict; HttpOnly; Secure; Max-Age=60",
    );
    expect(cookieHeader("b", "v", { httpOnly: false, secure: false })).toBe("b=v; Path=/admin; SameSite=Strict");
  });

  it("read the named cookie", () => {
    expect(readCookie("x=1; aigw_session=abc; y=2", "aigw_session")).toBe("abc");
    expect(readCookie("aigw_sessionx=1", "aigw_session")).toBeUndefined();
    expect(readCookie(undefined, "a")).toBeUndefined();
  });
});
