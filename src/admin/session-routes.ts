/**
 * Console session endpoints and the cookie-session admin auth (0.3.0 P6, plan §9.4).
 *
 *   POST   /admin/session/login    { key } → session cookie + CSRF cookie (public; per-IP lockout, global slowdown)
 *   POST   /admin/session/logout   ends the session (cookies cleared)
 *   GET    /admin/session          who is signed in (+ csrfToken for a cookie session)
 *   GET    /admin/sessions         live console sessions
 *   DELETE /admin/sessions/:id     revoke one (admin, or your own)
 *
 * sessionOrCredential() wraps the Bearer / X-Admin-Secret middleware: a request
 * carrying either header is authenticated exactly as before (cookies ignored);
 * otherwise the session cookie is accepted, and every non-GET needs the
 * double-submit CSRF token. Only /admin/* ever sees these cookies.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { BootstrapGate } from "../auth/bootstrap.js";
import { keyCredentialVersion, resolveAdminCredential } from "../middleware/auth.js";
import { requestRemoteAddress } from "../middleware/per-ip-rate-limit.js";
import { parseTrustedProxies, resolveClientIp } from "../middleware/trusted-proxy.js";
import type { KeyStore } from "../persistence/key-store.js";
import { adminError, csrfGuard } from "./guards.js";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  cookieHeader,
  readCookie,
  SESSION_COOKIE,
  type ConsoleSession,
  type SessionManager,
} from "./session.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SCOPE_ADMIN = "admin";
const SCOPE_READ_ONLY = "read_only";

export interface SessionDeps {
  readonly sessions: SessionManager;
  readonly keyStore?: KeyStore;
  readonly adminSecret?: string;
  readonly bootstrap?: BootstrapGate;
  readonly allowedOrigins?: () => readonly string[] | undefined;
  /** Audit hook (config store), never given a credential. */
  readonly audit?: (actor: string, action: string, sessionId: string | null, detail: Record<string, unknown>) => void;
}

const trustedProxies = parseTrustedProxies(process.env["TRUSTED_PROXIES"]);

function clientIp(c: Context): string {
  return resolveClientIp(requestRemoteAddress(c), Object.fromEntries(c.req.raw.headers.entries()), trustedProxies);
}

function isSecure(c: Context, mode: "auto" | "always" | "never"): boolean {
  if (mode !== "auto") return mode === "always";
  if (new URL(c.req.url).protocol === "https:") return true;
  const fwd = c.req.header("X-Forwarded-Proto")?.split(",")[0]?.trim().toLowerCase();
  return fwd === "https";
}

function setSessionCookies(c: Context, deps: SessionDeps, token: string, csrf: string): void {
  const secure = isSecure(c, deps.sessions.secureCookie);
  const maxAge = deps.sessions.ttlMs / 1000;
  c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, token, { httpOnly: true, secure, maxAgeSeconds: maxAge }), {
    append: true,
  });
  c.header("Set-Cookie", cookieHeader(CSRF_COOKIE, csrf, { httpOnly: false, secure, maxAgeSeconds: maxAge }), {
    append: true,
  });
}

function clearSessionCookies(c: Context, deps: SessionDeps): void {
  const secure = isSecure(c, deps.sessions.secureCookie);
  c.header("Set-Cookie", cookieHeader(SESSION_COOKIE, "", { httpOnly: true, secure, maxAgeSeconds: 0 }), {
    append: true,
  });
  c.header("Set-Cookie", cookieHeader(CSRF_COOKIE, "", { httpOnly: false, secure, maxAgeSeconds: 0 }), {
    append: true,
  });
}

function setVar(c: Context, key: string, value: unknown): void {
  (c.set as unknown as (k: string, v: unknown) => void)(key, value);
}

function getVar(c: Context, key: string): unknown {
  return (c.get as unknown as (k: string) => unknown)(key);
}

/**
 * Is the session still backed by a valid credential? Store-key sessions follow
 * the key (revoked, rotated, expired or scope removed → ended; scopes refreshed);
 * bootstrap sessions end once bootstrap keys are retired.
 */
function stillValid(s: ConsoleSession, deps: SessionDeps): boolean {
  if (s.kind === "bootstrap") return deps.bootstrap?.disabledReason() === undefined;
  if (s.kind === "secret") return deps.adminSecret !== undefined && deps.adminSecret !== "";
  if (s.keyId === undefined || deps.keyStore === undefined) return false;
  const k = deps.keyStore.get(s.keyId);
  if (k === null || !k.active || k.revokedAt !== null) return false;
  if (k.expiresAt !== null && new Date() > k.expiresAt) return false;
  if (!k.scopes.includes(SCOPE_ADMIN) && !k.scopes.includes(SCOPE_READ_ONLY)) return false;
  // Rotated since sign-in (also by another process, e.g. the CLI on the same database): the old secret is dead (RA4).
  if (s.credentialVersion === undefined || s.credentialVersion !== keyCredentialVersion(k.rotatedAt)) return false;
  s.scopes = [...k.scopes];
  return true;
}

/** Public login / logout routes; register before the admin auth middleware. */
export function registerSessionPublicRoutes(app: Hono<never>, deps: SessionDeps): void {
  const r = app as unknown as Hono;
  const guard = csrfGuard({ allowedOrigins: deps.allowedOrigins });

  r.post("/session/login", guard, async (c) => {
    c.header("Cache-Control", "no-store");
    const ip = clientIp(c);
    const wait = deps.sessions.loginBlocked(ip);
    if (wait !== undefined) {
      c.header("Retry-After", String(wait));
      return adminError(c, 429, "login_locked", `Too many failed sign-ins; try again in ${wait}s`, {
        retryAfter: wait,
      });
    }
    // Many failures overall slow every attempt down (≤ 2 s) instead of refusing it (RA1).
    const delay = deps.sessions.loginDelayMs();
    if (delay > 0) await Bun.sleep(delay);
    let key: unknown;
    try {
      const body = (await c.req.json()) as unknown;
      key = body && typeof body === "object" ? (body as Record<string, unknown>)["key"] : undefined;
    } catch {
      return adminError(c, 400, "invalid_request", 'Body must be JSON: { "key": "…" }', { param: "key" });
    }
    if (typeof key !== "string" || key === "" || key.length > 512) {
      return adminError(c, 400, "invalid_request", "key is required", { param: "key" });
    }
    const cred = resolveAdminCredential(
      {
        ...(deps.keyStore ? { keyStore: deps.keyStore } : {}),
        ...(deps.adminSecret ? { adminSecret: deps.adminSecret } : {}),
        ...(deps.bootstrap ? { bootstrap: deps.bootstrap } : {}),
      },
      key,
    );
    if (cred === undefined || cred === "insufficient_scope") {
      const locked = deps.sessions.loginFailed(ip);
      deps.audit?.("anonymous", "console_login_failed", null, { ip, ...(locked ? { lockedOut: true } : {}) });
      if (cred === "insufficient_scope") {
        return adminError(c, 403, "insufficient_scope", "This key cannot use the console (admin or read_only needed)");
      }
      return adminError(c, 401, "invalid_credentials", "Invalid admin key");
    }
    deps.sessions.loginSucceeded(ip);
    const { token, session } = deps.sessions.create({
      actor: cred.actor,
      kind: cred.kind,
      ...(cred.keyId !== undefined ? { keyId: cred.keyId } : {}),
      ...(cred.credentialVersion !== undefined ? { credentialVersion: cred.credentialVersion } : {}),
      scopes: cred.scopes,
      ip,
      userAgent: c.req.header("User-Agent") ?? "",
    });
    setSessionCookies(c, deps, token, session.csrfToken);
    deps.audit?.(cred.actor, "console_login", session.id, { ip });
    return c.json({
      actor: session.actor,
      scopes: session.scopes,
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      idleTimeoutSeconds: deps.sessions.idleMs / 1000,
    });
  });

  r.post("/session/logout", guard, (c) => {
    c.header("Cache-Control", "no-store");
    const token = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
    const s = deps.sessions.touch(token);
    if (s) {
      const ok = deps.sessions.csrfValid(s, c.req.header(CSRF_HEADER), readCookie(c.req.header("Cookie"), CSRF_COOKIE));
      if (!ok) return adminError(c, 403, "csrf_token_invalid", "Missing or wrong CSRF token");
      deps.sessions.end(s);
      deps.audit?.(s.actor, "console_logout", s.id, {});
    }
    clearSessionCookies(c, deps);
    return c.body(null, 204);
  });
}

/**
 * Admin auth: Bearer / X-Admin-Secret through `credentialAuth` (unchanged), else
 * the console session cookie (+ CSRF on writes).
 */
export function sessionOrCredential(deps: SessionDeps, credentialAuth: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    const hasHeaderCredential =
      c.req.header("Authorization") !== undefined || c.req.header("X-Admin-Secret") !== undefined;
    const cookies = c.req.header("Cookie");
    const token = hasHeaderCredential ? undefined : readCookie(cookies, SESSION_COOKIE);
    if (token === undefined) return credentialAuth(c, next);
    const s = deps.sessions.touch(token);
    if (!s || !stillValid(s, deps)) {
      if (s) deps.sessions.end(s);
      clearSessionCookies(c, deps);
      return adminError(c, 401, "session_expired", "The console session has expired; sign in again");
    }
    if (
      !SAFE_METHODS.has(c.req.method) &&
      !deps.sessions.csrfValid(s, c.req.header(CSRF_HEADER), readCookie(cookies, CSRF_COOKIE))
    ) {
      return adminError(c, 403, "csrf_token_invalid", "Missing or wrong CSRF token (X-CSRF-Token)");
    }
    setVar(c, "apiKey", undefined);
    setVar(c, "keyScopes", s.scopes);
    setVar(c, "actor", s.actor);
    setVar(c, "consoleSession", s);
    if (s.kind === "bootstrap") setVar(c, "authMethod", "bootstrap");
    await next();
  };
}

/**
 * Failure limiting for the header credentials (X-Admin-Secret, Authorization:
 * Bearer) on /admin/* (red team 2026-11-05 P4: they had none, so a client
 * locked out of the console could still guess adminSecret at ~10,000/s).
 * Same rules and the same per-IP counter as the console sign-in:
 *  - a 401 for a presented credential counts as one failure of the client IP;
 *    maxLoginFailures within lockoutMinutes locks that IP out;
 *  - a locked IP gets 429 auth_locked (Retry-After) for every header
 *    credential, valid or not, until the lockout ends — as the console refuses
 *    a valid key from a locked IP (checking it would answer the guess);
 *  - many failures overall (any IP) slow every attempt down (≤ 2 s), never
 *    refuse one (RA1);
 *  - a success does not clear the IP's failures (unlike the console, whose
 *    reset needs a full sign-in): otherwise a read_only key holder could
 *    interleave valid requests to guess adminSecret without limit.
 * Requests without credential headers (and valid keys lacking the scope,
 * 403) are not counted.
 */
export function limitCredentialFailures(deps: SessionDeps, credentialAuth: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    const presented = c.req.header("Authorization") !== undefined || c.req.header("X-Admin-Secret") !== undefined;
    if (!presented) return credentialAuth(c, next);
    const ip = clientIp(c);
    const wait = deps.sessions.loginBlocked(ip);
    if (wait !== undefined) {
      c.header("Retry-After", String(wait));
      return adminError(c, 429, "auth_locked", `Too many failed admin credentials; try again in ${wait}s`, {
        retryAfter: wait,
      });
    }
    const delay = deps.sessions.loginDelayMs();
    if (delay > 0) await Bun.sleep(delay);
    let passed = false;
    const res = await credentialAuth(c, async () => {
      passed = true;
      await next();
    });
    if (!passed && (res instanceof Response ? res.status : c.res.status) === 401) {
      if (deps.sessions.loginFailed(ip)) deps.audit?.("anonymous", "admin_auth_locked", null, { ip });
    }
    return res;
  };
}

/** Session info and management; register after the auth middleware. */
export function registerSessionRoutes(app: Hono<never>, deps: SessionDeps): void {
  const r = app as unknown as Hono;
  r.get("/session", (c) => {
    c.header("Cache-Control", "no-store");
    const s = getVar(c, "consoleSession") as ConsoleSession | undefined;
    const scopes = (getVar(c, "keyScopes") as string[] | undefined) ?? [];
    const actor = (getVar(c, "actor") as string | undefined) ?? "admin";
    if (!s) return c.json({ via: "header", actor, scopes });
    return c.json({
      via: "session",
      actor,
      scopes,
      sessionId: s.id,
      csrfToken: s.csrfToken,
      expiresAt: new Date(s.expiresAt).toISOString(),
      idleTimeoutSeconds: deps.sessions.idleMs / 1000,
    });
  });

  r.get("/sessions", (c) => {
    c.header("Cache-Control", "no-store");
    const own = getVar(c, "consoleSession") as ConsoleSession | undefined;
    return c.json({
      object: "list",
      data: deps.sessions.list().map((v) => ({ ...v, current: own?.id === v.id })),
    });
  });

  r.delete("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const own = getVar(c, "consoleSession") as ConsoleSession | undefined;
    const scopes = (getVar(c, "keyScopes") as string[] | undefined) ?? [];
    if (own?.id !== id && !scopes.includes(SCOPE_ADMIN)) {
      return adminError(c, 403, "insufficient_scope", "Revoking another session needs the admin scope");
    }
    if (!deps.sessions.revoke(id)) return adminError(c, 404, "not_found", `session ${id} not found`);
    deps.audit?.((getVar(c, "actor") as string | undefined) ?? "admin", "console_session_revoked", id, {});
    if (own?.id === id) clearSessionCookies(c, deps);
    return c.body(null, 204);
  });
}
