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
 *  - login failures are rate limited per client IP with a lockout; many failures overall
 *    (≥ 60 a minute, any IP) only slow every sign-in attempt down (≤ 2 s), never refuse
 *    one, so a flood of bad attempts cannot lock the real admin out (red team RA1);
 *  - the map is keyed by SHA-256 of the cookie value; listing shows a separate public id;
 *  - sessions minted from a store key are re-checked against the key store on every
 *    admin request (revoked / rotated / expired / scope removed → session ends); bootstrap
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
  /** Live sessions per credential (default 5): a new sign-in ends that credential's oldest (FA-3). */
  readonly maxSessionsPerCredential?: number;
  /** Successful sign-ins per client IP per minute (default 20, FA-3). */
  readonly maxLoginsPerMinute?: number;
}

/** Why `create` refused a session (FA-3): the table is full of other credentials' sessions. */
export class SessionLimitError extends Error {
  override name = "SessionLimitError";
}

export type SessionKind = "secret" | "bootstrap" | "key";

export interface ConsoleSession {
  /** Public id shown in the session list (not the cookie value). */
  readonly id: string;
  /** Which credential signed in (store key id, adminSecret, bootstrap key + scope): the per-credential cap's key. */
  readonly credential: string;
  readonly hash: string;
  readonly csrfToken: string;
  readonly actor: string;
  readonly kind: SessionKind;
  readonly keyId?: string;
  /** Store-key sessions: the key's secret version at sign-in; a rotation ends the session (RA4). */
  readonly credentialVersion?: string;
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

/** Live console sessions in total (all credentials). */
export const MAX_SESSIONS = 64;
export const DEFAULT_MAX_SESSIONS_PER_CREDENTIAL = 5;
export const DEFAULT_MAX_LOGINS_PER_MINUTE = 20;
/** Failures a minute (all IPs) above which every sign-in attempt is slowed down (RA1: was a hard 429 for everyone). */
export const GLOBAL_SLOWDOWN_FAILURES_PER_MINUTE = 60;
/** Slowdown per multiple of the threshold, and its ceiling. */
export const GLOBAL_SLOWDOWN_STEP_MS = 500;
export const GLOBAL_SLOWDOWN_MAX_MS = 2000;

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
  readonly maxPerCredential: number;
  readonly maxLoginsPerMinute: number;
  private readonly logins = new Map<string, { start: number; count: number }>();
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
    this.maxPerCredential = opts.maxSessionsPerCredential ?? DEFAULT_MAX_SESSIONS_PER_CREDENTIAL;
    this.maxLoginsPerMinute = opts.maxLoginsPerMinute ?? DEFAULT_MAX_LOGINS_PER_MINUTE;
  }

  /**
   * Count one successful sign-in of this client IP (FA-3); returns seconds to
   * wait when it is over `maxLoginsPerMinute` (the sign-in is then refused),
   * else undefined. Failed sign-ins are limited by the lockout instead.
   */
  takeLogin(ip: string): number | undefined {
    const t = this.now();
    let w = this.logins.get(ip);
    if (!w || t - w.start >= 60_000) {
      if (this.logins.size > 10_000) this.logins.clear();
      w = { start: t, count: 0 };
      this.logins.set(ip, w);
    }
    if (w.count >= this.maxLoginsPerMinute) return Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000));
    w.count++;
    return undefined;
  }

  /**
   * Seconds this client IP must wait before another login attempt, else undefined.
   * Only the per-IP lockout refuses a login: there is no global lockout (RA1).
   */
  loginBlocked(ip: string): number | undefined {
    const t = this.now();
    const f = this.failures.get(ip);
    if (f && f.lockedUntil > t) return Math.max(1, Math.ceil((f.lockedUntil - t) / 1000));
    return undefined;
  }

  /**
   * Delay (ms) to apply to a login attempt before its credential is checked:
   * 0 normally; while failures from all IPs in the current minute reach the
   * threshold, 500 ms per multiple of it, at most 2 s. It slows a distributed
   * guesser (each attempt costs the delay) but never refuses the real admin.
   */
  loginDelayMs(): number {
    const t = this.now();
    if (t - this.globalWindow.start >= 60_000) return 0;
    const n = Math.floor(this.globalWindow.count / GLOBAL_SLOWDOWN_FAILURES_PER_MINUTE);
    return Math.min(GLOBAL_SLOWDOWN_MAX_MS, n * GLOBAL_SLOWDOWN_STEP_MS);
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

  // A successful sign-in never clears the IP's failures (final red team
  // 2026-11-06 FA-2): otherwise a read_only key holder could interleave one
  // valid sign-in every few guesses and guess adminSecret without limit.
  // Failures age out with lockoutMinutes, exactly as on the header path.

  /**
   * Create a session; returns the cookie value (only ever sent to the browser) and the session.
   *
   * Capacity (FA-3): each credential keeps at most `maxSessionsPerCredential`
   * sessions — a new sign-in ends that credential's least recently used one.
   * When the whole table (MAX_SESSIONS) is full, an admin-scope sign-in may end
   * the least recently used session of a credential WITHOUT the admin scope;
   * nothing ever ends another credential's admin session, and a read_only
   * sign-in never ends anyone else's: it gets SessionLimitError instead.
   */
  create(input: {
    actor: string;
    kind: SessionKind;
    keyId?: string;
    credentialVersion?: string;
    scopes: string[];
    ip: string;
    userAgent: string;
  }): { token: string; session: ConsoleSession } {
    this.sweep();
    const credential = credentialId(input);
    const own = [...this.sessions.values()].filter((s) => s.credential === credential);
    own.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    while (own.length >= this.maxPerCredential) {
      const oldest = own.shift();
      if (oldest) this.sessions.delete(oldest.hash);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      let victim: ConsoleSession | undefined;
      if (input.scopes.includes("admin")) {
        for (const s of this.sessions.values()) {
          if (s.scopes.includes("admin")) continue;
          if (!victim || s.lastSeenAt < victim.lastSeenAt) victim = s;
        }
      }
      if (!victim) throw new SessionLimitError("Too many console sessions are open; try again later");
      this.sessions.delete(victim.hash);
    }
    const token = randomToken();
    const t = this.now();
    const session: ConsoleSession = {
      id: `ses_${randomToken(9)}`,
      credential,
      hash: sha256(token),
      csrfToken: randomToken(),
      actor: input.actor,
      kind: input.kind,
      ...(input.keyId !== undefined ? { keyId: input.keyId } : {}),
      ...(input.credentialVersion !== undefined ? { credentialVersion: input.credentialVersion } : {}),
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

  /** End every session signed in with this store key (rotate / revoke, RA4); returns how many. */
  endForKey(keyId: string): number {
    let n = 0;
    for (const [hash, s] of this.sessions) {
      if (s.kind === "key" && s.keyId === keyId) {
        this.sessions.delete(hash);
        n++;
      }
    }
    return n;
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

/** The credential a session belongs to: one store key, adminSecret, or a bootstrap key (by its scopes). */
function credentialId(input: { kind: SessionKind; keyId?: string; scopes: readonly string[] }): string {
  if (input.kind === "key") return `key:${input.keyId ?? ""}`;
  if (input.kind === "bootstrap") return `bootstrap:${[...input.scopes].sort().join(",")}`;
  return "secret";
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
