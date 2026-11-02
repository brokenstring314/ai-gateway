/**
 * Console sessions (0.3.0 P6, plan §9.4).
 *
 * The console never keeps the admin key in the browser: POST /admin/session/login
 * exchanges it for a server-side session, identified by an opaque random id in
 * an HttpOnly, SameSite=Strict cookie (Secure on https). Sessions live only in
 * this process's memory — a restart signs every console out — so they add no
 * database read anywhere, and nothing about them touches /v1/* (the client auth
 * middleware never looks at cookies).
 *
 *  - absolute lifetime (default 12 h) + idle timeout (default 60 min), both configurable;
 *  - double-submit CSRF: a second, script-readable cookie holds a random token that
 *    every cookie-authenticated write must echo in X-CSRF-Token; it must equal both the
 *    cookie and the token stored in the session (compared in constant time);
 *  - login failures are rate limited per client IP with a lockout, plus a global cap;
 *  - the map is keyed by SHA-256 of the cookie value; listing shows a separate public id;
 *  - sessions minted from a store key are re-checked against the key store on every
 *    admin request (revoked / expired / scope removed → session ends); bootstrap
 *    sessions end as soon as bootstrap keys are retired.
 */

import { timingSafeEqual } from "../auth/key-hash.js";

export const SESSION_COOKIE = "aigw_session";
export const CSRF_COOKIE = "aigw_csrf";
export const CSRF_HEADER = "X-CSRF-Token";
export const COOKIE_PATH = "/admin";

export interface ConsoleSessionOptions {
  /** Absolute lifetime in minutes (default 720 = 12 h). */
  readonly sessionTtlMinutes?: number;
  /** Idle timeout in minutes (default 60). */
  readonly idleTimeoutMinutes?: number;
  /** Failed logins per client IP before a lockout (default 5). */
  readonly maxLoginFailures?: number;
  /** Lockout length in minutes (default 15); also the failure counting window. */
  readonly lockoutMinutes?: number;
  /** Cookie Secure flag: auto (https request or X-Forwarded-Proto: https), always or never. */
  readonly secureCookie?: "auto" | "always" | "never";
}

export type SessionKind = "secret" | "bootstrap" | "key";

export interface ConsoleSession {
  /** Public id shown in the session list (not the cookie value). */
  readonly id: string;
  readonly hash: string;
  readonly csrfToken: string;
  readonly actor: string;
  readonly kind: SessionKind;
  readonly keyId?: string;
  scopes: string[];
  readonly createdAt: number;
  lastSeenAt: number;
  readonly expiresAt: number;
  readonly ip: string;
  readonly userAgent: string;
}

export interface SessionView {
  id: string;
  actor: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  idleExpiresAt: string;
  ip: string;
  userAgent: string;
}

const MAX_SESSIONS = 64;
const GLOBAL_FAILURES_PER_MINUTE = 60;

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export class SessionManager {
  readonly ttlMs: number;
  readonly idleMs: number;
  readonly maxFailures: number;
  readonly lockoutMs: number;
  readonly secureCookie: "auto" | "always" | "never";
  private readonly sessions = new Map<string, ConsoleSession>();
  private readonly failures = new Map<string, { first: number; count: number; lockedUntil: number }>();
  private globalWindow = { start: 0, count: 0 };

  constructor(
    opts: ConsoleSessionOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.ttlMs = (opts.sessionTtlMinutes ?? 720) * 60_000;
    this.idleMs = (opts.idleTimeoutMinutes ?? 60) * 60_000;
    this.maxFailures = opts.maxLoginFailures ?? 5;
    this.lockoutMs = (opts.lockoutMinutes ?? 15) * 60_000;
    this.secureCookie = opts.secureCookie ?? "auto";
  }

  /** Seconds the client must wait before another login attempt, else undefined. */
  loginBlocked(ip: string): number | undefined {
    const t = this.now();
    const f = this.failures.get(ip);
    if (f && f.lockedUntil > t) return Math.max(1, Math.ceil((f.lockedUntil - t) / 1000));
    if (t - this.globalWindow.start < 60_000 && this.globalWindow.count >= GLOBAL_FAILURES_PER_MINUTE) {
      return Math.max(1, Math.ceil((this.globalWindow.start + 60_000 - t) / 1000));
    }
    return undefined;
  }

  /** Record a failed login; returns true when this failure locked the client out. */
  loginFailed(ip: string): boolean {
    const t = this.now();
    if (t - this.globalWindow.start >= 60_000) this.globalWindow = { start: t, count: 0 };
    this.globalWindow.count++;
    let f = this.failures.get(ip);
    if (!f || (t - f.first >= this.lockoutMs && f.lockedUntil <= t)) {
      if (this.failures.size > 10_000) this.failures.clear();
      f = { first: t, count: 0, lockedUntil: 0 };
      this.failures.set(ip, f);
    }
    f.count++;
    if (f.count >= this.maxFailures) {
      f.lockedUntil = t + this.lockoutMs;
      f.count = 0;
      f.first = t;
      return true;
    }
    return false;
  }

  loginSucceeded(ip: string): void {
    this.failures.delete(ip);
  }

  /** Create a session; returns the cookie value (only ever sent to the browser) and the session. */
  create(input: {
    actor: string;
    kind: SessionKind;
    keyId?: string;
    scopes: string[];
    ip: string;
    userAgent: string;
  }): { token: string; session: ConsoleSession } {
    this.sweep();
    while (this.sessions.size >= MAX_SESSIONS) {
      // Evict the least recently used session.
      let oldest: ConsoleSession | undefined;
      for (const s of this.sessions.values()) if (!oldest || s.lastSeenAt < oldest.lastSeenAt) oldest = s;
      if (!oldest) break;
      this.sessions.delete(oldest.hash);
    }
    const token = randomToken();
    const t = this.now();
    const session: ConsoleSession = {
      id: `ses_${randomToken(9)}`,
      hash: sha256(token),
      csrfToken: randomToken(),
      actor: input.actor,
      kind: input.kind,
      ...(input.keyId !== undefined ? { keyId: input.keyId } : {}),
      scopes: [...input.scopes],
      createdAt: t,
      lastSeenAt: t,
      expiresAt: t + this.ttlMs,
      ip: input.ip.slice(0, 64),
      userAgent: input.userAgent.slice(0, 200),
    };
    this.sessions.set(session.hash, session);
    return { token, session };
  }

  /** The live session for a cookie value (refreshing its idle timer), else undefined. */
  touch(token: string | undefined): ConsoleSession | undefined {
    if (token === undefined || token === "" || token.length > 200) return undefined;
    const hash = sha256(token);
    const s = this.sessions.get(hash);
    if (!s) return undefined;
    const t = this.now();
    if (t >= s.expiresAt || t - s.lastSeenAt >= this.idleMs) {
      this.sessions.delete(hash);
      return undefined;
    }
    s.lastSeenAt = t;
    return s;
  }

  /** True when `header` and `cookie` both equal the session's CSRF token. */
  csrfValid(s: ConsoleSession, header: string | undefined, cookie: string | undefined): boolean {
    if (header === undefined || cookie === undefined || header === "" || cookie === "") return false;
    // Evaluate both comparisons (no short-circuit on the first).
    const a = timingSafeEqual(header, s.csrfToken);
    const b = timingSafeEqual(cookie, s.csrfToken);
    return a && b;
  }

  revokeByToken(token: string): void {
    this.sessions.delete(sha256(token));
  }

  /** Revoke by public id; false when unknown. */
  revoke(id: string): boolean {
    for (const [hash, s] of this.sessions) {
      if (s.id === id) {
        this.sessions.delete(hash);
        return true;
      }
    }
    return false;
  }

  end(s: ConsoleSession): void {
    this.sessions.delete(s.hash);
  }

  list(): SessionView[] {
    this.sweep();
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map((s) => this.view(s));
  }

  view(s: ConsoleSession): SessionView {
    return {
      id: s.id,
      actor: s.actor,
      scopes: [...s.scopes],
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString(),
      idleExpiresAt: new Date(Math.min(s.expiresAt, s.lastSeenAt + this.idleMs)).toISOString(),
      ip: s.ip,
      userAgent: s.userAgent,
    };
  }

  get size(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [hash, s] of this.sessions) {
      if (t >= s.expiresAt || t - s.lastSeenAt >= this.idleMs) this.sessions.delete(hash);
    }
  }
}

/** Serialize a cookie for the console (Path=/admin, SameSite=Strict). */
export function cookieHeader(
  name: string,
  value: string,
  opts: { httpOnly: boolean; secure: boolean; maxAgeSeconds?: number },
): string {
  const parts = [`${name}=${value}`, `Path=${COOKIE_PATH}`, "SameSite=Strict"];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`);
  return parts.join("; ");
}

/** Read one cookie from a Cookie header (first occurrence). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
