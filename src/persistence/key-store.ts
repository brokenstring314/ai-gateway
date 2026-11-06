/**
 * KeyStore — SQLite-backed API key persistence.
 *
 * Matches the Go SQLStore (internal/admin/sql_store.go):
 *   - 3-step migration sequence via the migration runner
 *   - prepared statements cached on the store instance
 *   - SHA-256 hash lookup (plaintext key never stored)
 *   - timing-safe hash comparison via timingSafeEqual
 *
 * Request path (FC-1): validateKey() never touches the database. Every key is
 * held in an in-memory snapshot keyed by its SHA-256 hash. The snapshot is
 * reloaded right after any write made through this store (admin API) and,
 * for writes made by another process (`ai-gateway keys ...`, a sqlite3
 * shell), when `PRAGMA data_version` changes — checked by a timer every
 * KEY_STORE_SYNC_INTERVAL_MS (default 1000 ms), off the request path. So a
 * key revoked or created by the CLI takes effect in a running server within
 * about one interval. usage_count / last_used_at are counted in memory and
 * written by the same timer (and on close).
 */

import { Database, type Statement } from "bun:sqlite";
import { join } from "node:path";
import { hashKey, displayKey, generateAPIKey, generateID, timingSafeEqual } from "@/auth/key-hash";
import { runMigrations, type MigrationStep } from "@/persistence/migrations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface APIKey {
  id: string;
  /** Full secret — populated ONLY on Create/Rotate responses; never stored. */
  key: string;
  keyDisplay: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  revokedAt: Date | null;
  expiresAt: Date | null;
  rotatedAt: Date | null;
  active: boolean;
  usageCount: number;
  lastUsedAt: Date | null;
  /** Published model names this key may use (aliases count by either name); null = every model. */
  allowedModels: string[] | null;
  /** Token quota (prompt + completion tokens, all time until reset); null = unlimited. */
  quotaTokens: number | null;
  /** Requests per minute for this key; null = the global rate-limit plugin value (if any). */
  rpm: number | null;
  /** Tokens per minute for this key; null = the global rate-limit plugin value (if any). */
  tpm: number | null;
  /**
   * Tokens counted against the quota, as last persisted. The running server
   * keeps the live value in memory (usage/key-meter.ts) and writes it back
   * asynchronously, so this can lag by a second or so.
   */
  usedTokens: number;
  /** When the usage was last reset by an operator; null = never. */
  usageResetAt: Date | null;
  /** Bumped by every change to the key's settings (If-Match / ETag on PATCH /admin/keys/:id). */
  revision: number;
}

/** Per-key limits (0.3.0 P5); null = no own limit. */
export interface KeyLimits {
  readonly quotaTokens: number | null;
  readonly rpm: number | null;
  readonly tpm: number | null;
}

/** Fields PATCH /admin/keys/:id may change; undefined = unchanged. */
export interface KeyPatch {
  name?: string;
  scopes?: string[];
  allowedModels?: readonly string[] | null;
  expiresAt?: Date | null;
  quotaTokens?: number | null;
  rpm?: number | null;
  tpm?: number | null;
}

/** Thrown by patch() when the key's revision is not the expected one. */
export class KeyRevisionMismatchError extends Error {
  constructor(readonly currentRevision: number) {
    super(`key revision mismatch (current: ${currentRevision})`);
    this.name = "KeyRevisionMismatchError";
  }
}

/** Throw unless `v` is null/undefined or an integer in [min, max]. */
export function assertLimit(field: string, v: unknown, min: number): asserts v is number | null | undefined {
  if (v === null || v === undefined) return;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) {
    throw new InvalidKeyLimitError(field, min);
  }
}

export class InvalidKeyLimitError extends Error {
  constructor(field: string, min: number) {
    super(`'${field}' must be null or an integer >= ${min}`);
    this.name = "InvalidKeyLimitError";
  }
}

/**
 * Thrown by create()/update() with `requireUnlatched` when the bootstrap
 * latch is already set (see isBootstrapLatched). Callers authenticated with a
 * bootstrap key map it to 401, the same answer as an invalid credential.
 */
export class BootstrapLatchedError extends Error {
  constructor() {
    super("bootstrap latch is set; bootstrap credentials are refused");
    this.name = "BootstrapLatchedError";
  }
}

export interface KeyWriteOptions {
  /**
   * Fail with BootstrapLatchedError (and write nothing) if the bootstrap
   * latch is already set. Checked inside the write transaction, so of two
   * concurrent bootstrap-authenticated requests creating an admin key only
   * the first succeeds.
   */
  requireUnlatched?: boolean;
}

/** Normalize an allowed-models list: trimmed, non-empty, unique; null = unrestricted. */
export function normalizeAllowedModels(models: readonly unknown[] | null | undefined): string[] | null {
  if (models === null || models === undefined) return null;
  const out: string[] = [];
  for (const m of models) {
    if (typeof m !== "string" || m.trim() === "" || m.length > 200) {
      throw new InvalidAllowedModelsError(m);
    }
    if (!out.includes(m.trim())) out.push(m.trim());
  }
  return out;
}

export class InvalidAllowedModelsError extends Error {
  constructor(value: unknown) {
    super(`invalid allowed model: ${JSON.stringify(value)}; expected non-empty model names (max 200 chars)`);
    this.name = "InvalidAllowedModelsError";
  }
}

/** Data directory used when none is given: GATEWAY_DATA_DIR, else ./.data. */
export function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env["GATEWAY_DATA_DIR"] ?? ".data";
}

/** The API key store database inside a data directory. */
export function keyStorePath(dataDir: string): string {
  return join(dataDir, "api-keys.sqlite");
}

/**
 * Open (or create) the key store database with the settings every process
 * sharing it uses: WAL journal (readers never block the writer) and a busy
 * timeout, so the CLI (`ai-gateway keys ...`) can write while the server runs.
 */
export function openKeyStoreDatabase(path: string, opts: { create?: boolean; busyTimeoutMs?: number } = {}): Database {
  const db = new Database(path, { create: opts.create ?? true, readwrite: true });
  // The CLI may wait (default 5 s); the server passes a short timeout because
  // bun:sqlite waits synchronously and would stall the event loop.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`);
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Another connection holds the database in rollback mode; keep its mode.
  }
  // WAL + NORMAL: no fsync per commit; a power cut can lose the last commits, never corrupt the file.
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/** Busy timeout of the server's key-store connection (admin writes). */
export const SERVER_KEY_STORE_BUSY_TIMEOUT_MS = 1000;
/** Busy timeout of the background sync / usage flush: never stall the event loop; retried next tick. */
const BACKGROUND_BUSY_TIMEOUT_MS = 25;
/** Default interval of the background sync (CLI changes, usage counters). */
export const DEFAULT_KEY_STORE_SYNC_INTERVAL_MS = 1000;

export interface KeyStoreOptions {
  /**
   * How often (ms) the store checks for writes by other processes and
   * flushes usage counters. Default: KEY_STORE_SYNC_INTERVAL_MS or 1000,
   * clamped to 50..10000. 0 = no timer (tests call syncNow()).
   */
  syncIntervalMs?: number;
  /** Busy timeout restored after a background statement (the connection's own setting). Default 5000. */
  busyTimeoutMs?: number;
}

function resolveSyncInterval(v: number | undefined): number {
  if (v === 0) return 0;
  const env = Number(process.env["KEY_STORE_SYNC_INTERVAL_MS"]);
  const raw = v ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_KEY_STORE_SYNC_INTERVAL_MS);
  return Math.min(10_000, Math.max(50, Math.floor(raw)));
}

export class KeyNotFoundError extends Error {
  constructor(id: string) {
    super(`key not found: ${id}`);
    this.name = "KeyNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEDGER = "api_key_schema_migrations";
/** Meta table row: set once the first admin key exists; never cleared. */
const META_BOOTSTRAP_LATCH = "admin_bootstrap_latched_at";
const PRIMARY_TABLE = "api_keys";
/** Full management access: /admin/* (read and write) and /v1/*. */
export const SCOPE_ADMIN = "admin";
/** Read-only management access: GET /admin/* and /v1/*. */
export const SCOPE_READ_ONLY = "read_only";
/** Inference only: /v1/*; rejected on /admin/*. Default for new keys. */
export const SCOPE_INFERENCE = "inference";
/** Every scope a key may carry. */
export const VALID_SCOPES: readonly string[] = [SCOPE_ADMIN, SCOPE_READ_ONLY, SCOPE_INFERENCE];
/** Scopes given to a key created without any (least privilege). */
export const DEFAULT_SCOPES: readonly string[] = [SCOPE_INFERENCE];

export class InvalidScopeError extends Error {
  constructor(scope: unknown) {
    super(`invalid scope: ${JSON.stringify(scope)}; allowed: ${VALID_SCOPES.join(", ")}`);
    this.name = "InvalidScopeError";
  }
}

/** Throw InvalidScopeError unless every entry is a known scope string. */
export function assertValidScopes(scopes: readonly unknown[]): asserts scopes is string[] {
  for (const scope of scopes) {
    if (typeof scope !== "string" || !VALID_SCOPES.includes(scope)) {
      throw new InvalidScopeError(scope);
    }
  }
}

/** Every column the in-memory snapshot needs (the hash is its map key). */
const SNAPSHOT_SELECT =
  "SELECT id, key_hash, key_display, name, scopes, created_at, revoked_at, expires_at, rotated_at, active, usage_count, last_used_at, allowed_models, quota_tokens, rpm, tpm, used_tokens, usage_reset_at, revision FROM api_keys";

const KEY_ROW_SELECT =
  "SELECT id, key_display, name, scopes, created_at, revoked_at, expires_at, rotated_at, active, usage_count, last_used_at, allowed_models, quota_tokens, rpm, tpm, used_tokens, usage_reset_at, revision FROM api_keys";

// ---------------------------------------------------------------------------
// Migration steps
// ---------------------------------------------------------------------------

/**
 * Version 1: baseline — CREATE TABLE with the hashed-key schema (key_hash +
 * key_display from the start; we build fresh, not migrating from the legacy
 * plaintext `key` column).
 *
 * Version 2: api_keys_hash — no-op fn. We already have key_hash + key_display
 * from v1, but keep the step for version parity with the Go migration.
 *
 * Version 3: api_keys_scrub — NoTx VACUUM + wal_checkpoint(TRUNCATE) to scrub
 * freed pages (matches Go's scrubFreedPages).
 */
function keyStoreSteps(): MigrationStep[] {
  return [
    {
      version: 1,
      name: "api_keys_baseline",
      sql: `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  key_display TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  expires_at DATETIME NULL,
  rotated_at DATETIME NULL,
  active BOOLEAN NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at DATETIME NULL
)`,
    },
    {
      version: 2,
      name: "api_keys_hash",
      fn: (db) => {
        // Verify key_hash and key_display columns exist (they do, from v1).
        // This is a no-op parity step with the Go migration.
        const cols = db.query("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        if (!names.has("key_hash") || !names.has("key_display")) {
          throw new Error("api_keys table missing key_hash or key_display columns");
        }
      },
    },
    {
      version: 3,
      name: "api_keys_scrub",
      noTx: (db) => {
        db.exec("VACUUM");
        const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as [number, number, number] | null;
        if (row !== null && row[0] !== 0 && row[1] > 0) {
          console.warn(`api_keys_scrub: wal_checkpoint busy, ${row[1]} frames left unmerged`);
        }
      },
    },
    {
      // Small key/value table for store-wide state, starting with the
      // one-way bootstrap latch. A database that already holds any
      // admin-scoped key (active, revoked or expired) is latched on upgrade:
      // an admin credential has existed, so the bootstrap key is retired.
      version: 4,
      name: "api_key_meta_bootstrap_latch",
      fn: (db) => {
        db.exec("CREATE TABLE IF NOT EXISTS api_key_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        const rows = db.query("SELECT scopes FROM api_keys").all() as Array<{ scopes: string }>;
        if (rows.some((r) => scopesIncludeAdmin(r.scopes))) {
          db.prepare("INSERT OR IGNORE INTO api_key_meta(key, value) VALUES(?, ?)").run(
            META_BOOTSTRAP_LATCH,
            new Date().toISOString(),
          );
        }
      },
    },
    {
      // 0.3.0 P2: per-key model allow-list (JSON array; NULL = every model).
      version: 5,
      name: "api_keys_allowed_models",
      fn: (db) => {
        const cols = db.query("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "allowed_models")) {
          db.exec("ALTER TABLE api_keys ADD COLUMN allowed_models TEXT NULL");
        }
      },
    },
    {
      // 0.3.0 P5: per-key token quota, RPM / TPM, the tokens used so far
      // (persisted asynchronously by the server) and a revision for If-Match.
      version: 6,
      name: "api_keys_limits_and_usage",
      fn: (db) => {
        const cols = new Set(
          (db.query("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        const add = (name: string, ddl: string) => {
          if (!cols.has(name)) db.exec(`ALTER TABLE api_keys ADD COLUMN ${ddl}`);
        };
        add("quota_tokens", "quota_tokens INTEGER NULL");
        add("rpm", "rpm INTEGER NULL");
        add("tpm", "tpm INTEGER NULL");
        add("used_tokens", "used_tokens INTEGER NOT NULL DEFAULT 0");
        add("usage_reset_at", "usage_reset_at DATETIME NULL");
        add("revision", "revision INTEGER NOT NULL DEFAULT 1");
      },
    },
  ];
}

function scopesIncludeAdmin(raw: string): boolean {
  try {
    const scopes: unknown = JSON.parse(raw);
    return Array.isArray(scopes) && scopes.includes(SCOPE_ADMIN);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Row shape from SQLite (raw, before parsing into APIKey)
// ---------------------------------------------------------------------------

/** One snapshot entry: the stored hash (compared timing-safely) and the parsed key. */
interface CachedKey {
  readonly hash: string;
  readonly key: APIKey;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface KeyRow {
  id: string;
  key_hash?: string;
  key_display: string;
  name: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  rotated_at: string | null;
  active: number;
  usage_count: number;
  last_used_at: string | null;
  allowed_models: string | null;
  quota_tokens: number | null;
  rpm: number | null;
  tpm: number | null;
  used_tokens: number;
  usage_reset_at: string | null;
  revision: number;
}

function parseRow(row: KeyRow): APIKey {
  let scopes: string[];
  try {
    scopes = JSON.parse(row.scopes) as string[];
  } catch {
    scopes = [];
  }
  return {
    id: row.id,
    key: row.key_display,
    keyDisplay: row.key_display,
    name: row.name,
    scopes,
    createdAt: new Date(row.created_at),
    revokedAt: row.revoked_at !== null ? new Date(row.revoked_at) : null,
    expiresAt: row.expires_at !== null ? new Date(row.expires_at) : null,
    rotatedAt: row.rotated_at !== null ? new Date(row.rotated_at) : null,
    active: row.active === 1,
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at !== null ? new Date(row.last_used_at) : null,
    allowedModels: parseAllowedModels(row.allowed_models),
    quotaTokens: row.quota_tokens,
    rpm: row.rpm,
    tpm: row.tpm,
    usedTokens: row.used_tokens,
    usageResetAt: row.usage_reset_at !== null ? new Date(row.usage_reset_at) : null,
    revision: row.revision,
  };
}

/** A stored list that cannot be read restricts the key to nothing (fail closed). */
function parseAllowedModels(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// KeyStore
// ---------------------------------------------------------------------------

export class KeyStore {
  private readonly db: Database;
  private stmtGetByID!: Statement<KeyRow, [string]>;
  private stmtRevoke!: Statement<unknown, [string, number, string]>;
  private stmtUpdate!: Statement<unknown, [string, string, string]>;
  private stmtSetExpiry!: Statement<unknown, [string | null, string]>;
  private stmtDelete!: Statement<unknown, [string]>;
  private stmtRotate!: Statement<unknown, [string, string, string, string]>;
  private stmtGetLatch!: Statement<{ value: string }, [string]>;
  private stmtSetLatch!: Statement<unknown, [string, string]>;
  /** The latch is one-way, so once seen set it is cached. */
  private latchedAt: Date | null = null;
  /** In-memory snapshot of every key, by SHA-256 hash; null until first needed. */
  private snapshot: Map<string, CachedKey> | null = null;
  /** `PRAGMA data_version` when the snapshot was loaded (changes on other connections' commits). */
  private dataVersion = -1;
  /** usage_count increments / last use not yet written, by key id. */
  private pendingUsage = new Map<string, { count: number; lastUsedAt: Date }>();
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private readonly syncIntervalMs: number;
  private readonly busyTimeoutMs: number;
  private closed = false;

  private constructor(db: Database, opts: KeyStoreOptions) {
    this.db = db;
    this.syncIntervalMs = resolveSyncInterval(opts.syncIntervalMs);
    this.busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  }

  static async create(db: Database, opts: KeyStoreOptions = {}): Promise<KeyStore> {
    const store = new KeyStore(db, opts);
    await runMigrations(db, keyStoreSteps(), {
      ledger: LEDGER,
      primaryTable: PRIMARY_TABLE,
    });
    store.initStatements();
    return store;
  }

  private initStatements(): void {
    this.stmtGetByID = this.db.prepare<KeyRow, [string]>(`${KEY_ROW_SELECT} WHERE id = ?`);
    this.stmtRevoke = this.db.prepare(
      "UPDATE api_keys SET revoked_at = ?, active = ?, revision = revision + 1 WHERE id = ?",
    );
    this.stmtUpdate = this.db.prepare("UPDATE api_keys SET name = ?, scopes = ?, revision = revision + 1 WHERE id = ?");
    this.stmtSetExpiry = this.db.prepare("UPDATE api_keys SET expires_at = ?, revision = revision + 1 WHERE id = ?");
    this.stmtDelete = this.db.prepare("DELETE FROM api_keys WHERE id = ?");
    this.stmtRotate = this.db.prepare(
      "UPDATE api_keys SET key_hash = ?, key_display = ?, rotated_at = ?, revision = revision + 1 WHERE id = ?",
    );
    this.stmtGetLatch = this.db.prepare<{ value: string }, [string]>("SELECT value FROM api_key_meta WHERE key = ?");
    this.stmtSetLatch = this.db.prepare("INSERT OR IGNORE INTO api_key_meta(key, value) VALUES(?, ?)");
  }

  // -------------------------------------------------------------------------
  // Bootstrap latch
  // -------------------------------------------------------------------------

  /**
   * When the bootstrap latch was set, or null while it is not. The latch is
   * set in the same transaction that first stores an admin-scoped key
   * (create, or update granting admin) and is never cleared: revoking,
   * expiring or deleting every admin key does not re-enable
   * ADMIN_BOOTSTRAP_KEY. Read from the database (not just this instance), so
   * a key created by the CLI in another process is seen.
   */
  bootstrapLatchedAt(): Date | null {
    if (this.latchedAt !== null) return this.latchedAt;
    const row = this.stmtGetLatch.get(META_BOOTSTRAP_LATCH);
    if (row !== null) this.latchedAt = new Date(row.value);
    return this.latchedAt;
  }

  /** True once the first admin key has existed (see bootstrapLatchedAt). */
  isBootstrapLatched(): boolean {
    return this.bootstrapLatchedAt() !== null;
  }

  /**
   * Run `write` in an IMMEDIATE transaction (the write lock is taken up
   * front, so concurrent writers in other processes serialize), checking
   * and setting the latch around it.
   */
  private latchedWrite<T>(grantsAdmin: boolean, opts: KeyWriteOptions | undefined, write: () => T): T {
    try {
      return this.db
        .transaction(() => {
          if (opts?.requireUnlatched && this.stmtGetLatch.get(META_BOOTSTRAP_LATCH) !== null) {
            throw new BootstrapLatchedError();
          }
          const result = write();
          if (grantsAdmin) this.stmtSetLatch.run(META_BOOTSTRAP_LATCH, new Date().toISOString());
          return result;
        })
        .immediate();
    } finally {
      this.afterWrite();
    }
  }

  // -------------------------------------------------------------------------
  // In-memory snapshot (FC-1)
  // -------------------------------------------------------------------------

  /**
   * Reload the snapshot after a write through this store, so a revoke,
   * rotate, expiry change or delete via the admin API takes effect on the
   * very next request. Only when a snapshot exists (it is built lazily).
   */
  private afterWrite(): void {
    if (this.snapshot !== null && !this.closed) this.loadSnapshot(false);
  }

  /** Load every key into memory. `background`: short busy timeout, keep the old snapshot on failure. */
  private loadSnapshot(background: boolean): boolean {
    try {
      const run = () => {
        const version = this.readDataVersion();
        const rows = this.db.query<KeyRow, []>(SNAPSHOT_SELECT).all();
        const next = new Map<string, CachedKey>();
        for (const row of rows) {
          if (typeof row.key_hash !== "string") continue;
          next.set(row.key_hash, { hash: row.key_hash, key: parseRow(row) });
        }
        this.snapshot = next;
        this.dataVersion = version;
      };
      if (background) this.withBusyTimeout(BACKGROUND_BUSY_TIMEOUT_MS, run);
      else run();
      return true;
    } catch (err) {
      if (!background && this.snapshot === null) throw err;
      console.warn(
        `[keys] could not reload the API key snapshot, keeping the previous one and retrying: ${errMessage(err)}`,
      );
      // Force a retry on the next tick even if data_version does not change again.
      this.dataVersion = -1;
      return false;
    }
  }

  private readDataVersion(): number {
    const row = this.db.query("PRAGMA data_version").get() as { data_version: number } | null;
    return row?.data_version ?? -1;
  }

  /** Run `fn` with a temporary busy timeout on this connection. */
  private withBusyTimeout<T>(ms: number, fn: () => T): T {
    this.db.exec(`PRAGMA busy_timeout = ${ms}`);
    try {
      return fn();
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    }
  }

  /** The snapshot, built on first use (and the background sync started). */
  private keys(): Map<string, CachedKey> {
    if (this.snapshot === null) {
      this.loadSnapshot(false);
      this.startSync();
    }
    return this.snapshot as Map<string, CachedKey>;
  }

  /**
   * Load the snapshot now and start the background sync (server startup), so
   * not even the first request reads the database.
   */
  warm(): void {
    this.keys();
  }

  private startSync(): void {
    if (this.syncTimer !== undefined || this.syncIntervalMs === 0 || this.closed) return;
    this.syncTimer = setInterval(() => this.syncNow(), this.syncIntervalMs);
    (this.syncTimer as { unref?: () => void }).unref?.();
  }

  /**
   * One background sync step (the timer calls it; tests may too): write
   * pending usage counters, then reload the snapshot if another process
   * committed to the database since the last load. Never throws; a busy
   * database is retried on the next tick.
   */
  syncNow(): void {
    if (this.closed) return;
    this.flushUsageCounters();
    if (this.snapshot === null) return;
    let version: number;
    try {
      version = this.withBusyTimeout(BACKGROUND_BUSY_TIMEOUT_MS, () => this.readDataVersion());
    } catch (err) {
      console.warn(`[keys] could not check the API key store for changes, will retry: ${errMessage(err)}`);
      return;
    }
    if (version !== this.dataVersion) this.loadSnapshot(true);
  }

  /**
   * Write the in-memory usage_count increments and last-use times in one
   * transaction (short busy timeout; on failure they are kept and retried).
   * Called by the sync timer, the usage recorder's flush and close().
   */
  flushUsageCounters(): void {
    if (this.pendingUsage.size === 0 || this.closed) return;
    const batch = this.pendingUsage;
    this.pendingUsage = new Map();
    try {
      this.withBusyTimeout(BACKGROUND_BUSY_TIMEOUT_MS, () => {
        const stmt = this.db.query(
          "UPDATE api_keys SET usage_count = usage_count + ?, last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < ? THEN ? ELSE last_used_at END WHERE id = ?",
        );
        this.db.transaction(() => {
          for (const [id, u] of batch) {
            const at = u.lastUsedAt.toISOString();
            stmt.run(u.count, at, at, id);
          }
        })();
      });
    } catch (err) {
      console.warn(`[keys] could not write usage counters of ${batch.size} key(s), will retry: ${errMessage(err)}`);
      for (const [id, u] of batch) this.addPendingUsage(id, u.count, u.lastUsedAt);
    }
  }

  private addPendingUsage(id: string, count: number, at: Date): void {
    const cur = this.pendingUsage.get(id);
    if (cur === undefined) this.pendingUsage.set(id, { count, lastUsedAt: at });
    else {
      cur.count += count;
      if (at > cur.lastUsedAt) cur.lastUsedAt = at;
    }
  }

  /** Persisted counters plus what is still pending in memory. */
  private withPendingUsage(k: APIKey): APIKey {
    const p = this.pendingUsage.get(k.id);
    if (p === undefined) return k;
    return {
      ...k,
      usageCount: k.usageCount + p.count,
      lastUsedAt: k.lastUsedAt === null || p.lastUsedAt > k.lastUsedAt ? p.lastUsedAt : k.lastUsedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Generate a new API key. The full secret is returned; only the hash and
   * display form are persisted. Empty scopes default to ["inference"]
   * (inference only); admin access must be requested explicitly. Throws
   * InvalidScopeError for an unknown scope. An admin-scoped key sets the
   * bootstrap latch in the same transaction.
   */
  create(
    name: string,
    scopes: string[],
    expiresAt?: Date,
    opts?: KeyWriteOptions & { allowedModels?: readonly string[] | null } & Partial<KeyLimits>,
  ): APIKey {
    assertValidScopes(scopes);
    const allowedModels = normalizeAllowedModels(opts?.allowedModels);
    assertLimit("quotaTokens", opts?.quotaTokens, 0);
    assertLimit("rpm", opts?.rpm, 1);
    assertLimit("tpm", opts?.tpm, 1);
    const quotaTokens = opts?.quotaTokens ?? null;
    const rpm = opts?.rpm ?? null;
    const tpm = opts?.tpm ?? null;
    const finalScopes = scopes.length > 0 ? [...new Set(scopes)] : [...DEFAULT_SCOPES];
    const key = generateAPIKey();
    const id = generateID();
    const now = new Date();

    this.latchedWrite(finalScopes.includes(SCOPE_ADMIN), opts, () =>
      this.db
        .prepare(
          `INSERT INTO api_keys(id, key_hash, key_display, name, scopes, created_at, revoked_at, expires_at, rotated_at, active, usage_count, last_used_at, allowed_models, quota_tokens, rpm, tpm, used_tokens, revision)
         VALUES(?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, 0, 1)`,
        )
        .run(
          id,
          hashKey(key),
          displayKey(key),
          name,
          JSON.stringify(finalScopes),
          now.toISOString(),
          expiresAt ? expiresAt.toISOString() : null,
          1,
          0,
          allowedModels === null ? null : JSON.stringify(allowedModels),
          quotaTokens,
          rpm,
          tpm,
        ),
    );

    return {
      id,
      key,
      keyDisplay: displayKey(key),
      name,
      scopes: finalScopes,
      createdAt: now,
      revokedAt: null,
      expiresAt: expiresAt ?? null,
      rotatedAt: null,
      active: true,
      usageCount: 0,
      lastUsedAt: null,
      allowedModels,
      quotaTokens,
      rpm,
      tpm,
      usedTokens: 0,
      usageResetAt: null,
      revision: 1,
    };
  }

  // -------------------------------------------------------------------------
  // IsEmpty
  // -------------------------------------------------------------------------

  /** Returns true if no API keys exist. Stops at the first row. */
  isEmpty(): boolean {
    const row = this.db.query("SELECT 1 FROM api_keys LIMIT 1").get() as { "1": number } | null;
    return row === null;
  }

  /**
   * True if at least one usable admin-scoped key exists (active, not
   * revoked, not expired). Not what retires ADMIN_BOOTSTRAP_KEY: that is the
   * one-way latch (isBootstrapLatched), which revoking keys never clears.
   */
  hasActiveAdminKey(now: Date = new Date()): boolean {
    const rows = this.db
      .query("SELECT scopes, expires_at FROM api_keys WHERE active = 1 AND revoked_at IS NULL")
      .all() as Array<{ scopes: string; expires_at: string | null }>;
    for (const row of rows) {
      let scopes: unknown;
      try {
        scopes = JSON.parse(row.scopes);
      } catch {
        continue;
      }
      if (!Array.isArray(scopes) || !scopes.includes("admin")) continue;
      if (row.expires_at !== null && now > new Date(row.expires_at)) continue;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------

  get(id: string): APIKey | null {
    const row = this.stmtGetByID.get(id);
    if (row === null) return null;
    return this.withPendingUsage(parseRow(row));
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  list(): APIKey[] {
    const rows = this.db.query<KeyRow, []>(KEY_ROW_SELECT).all();
    return rows.map((r) => this.withPendingUsage(parseRow(r)));
  }

  // -------------------------------------------------------------------------
  // ValidateKey
  // -------------------------------------------------------------------------

  /**
   * Hash the provided key, look it up in the in-memory snapshot (by hash,
   * then a timing-safe comparison of the stored hash), check
   * active/revoked/expiry against the current time. No database access: the
   * usage counter and last-use time are counted in memory and written by the
   * background sync (FC-1).
   *
   * Returns the APIKey (with plaintext key replaced by display form) on
   * success, null on failure.
   */
  validateKey(key: string): APIKey | null {
    if (key === "") return null;

    const hash = hashKey(key);
    const cached = this.keys().get(hash);
    if (cached === undefined) return null;

    // Timing-safe comparison — never use === for hash equality.
    if (!timingSafeEqual(cached.hash, hash)) return null;

    const k = cached.key;
    if (!k.active || k.revokedAt !== null) return null;
    const now = new Date();
    if (k.expiresAt !== null && now > k.expiresAt) return null;

    this.addPendingUsage(k.id, 1, now);
    // A copy: callers may not change the snapshot.
    return {
      ...k,
      scopes: [...k.scopes],
      allowedModels: k.allowedModels === null ? null : [...k.allowedModels],
      usageCount: k.usageCount + (this.pendingUsage.get(k.id)?.count ?? 0),
      lastUsedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  /** Set active=false + revoked_at=now. Throws KeyNotFoundError if absent. */
  revoke(id: string): void {
    const now = new Date();
    const result = this.stmtRevoke.run(now.toISOString(), 0, id);
    this.afterWrite();
    if (result.changes === 0) {
      throw new KeyNotFoundError(id);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /**
   * Update name and/or scopes. Empty name is ignored; empty scopes are
   * ignored (matching Go). Throws InvalidScopeError for an unknown scope.
   * Returns the updated key.
   */
  /** Replace a key's model allow-list (null = every model). Throws KeyNotFoundError. */
  setAllowedModels(id: string, models: readonly unknown[] | null): APIKey {
    const allowedModels = normalizeAllowedModels(models);
    const current = this.get(id);
    if (current === null) throw new KeyNotFoundError(id);
    this.db
      .prepare("UPDATE api_keys SET allowed_models = ?, revision = revision + 1 WHERE id = ?")
      .run(allowedModels === null ? null : JSON.stringify(allowedModels), id);
    this.afterWrite();
    return { ...current, allowedModels, revision: current.revision + 1 };
  }

  update(id: string, name: string, scopes: string[], opts?: KeyWriteOptions): APIKey {
    assertValidScopes(scopes);
    const current = this.get(id);
    if (current === null) {
      throw new KeyNotFoundError(id);
    }

    const newName = name !== "" ? name : current.name;
    const newScopes = scopes.length > 0 ? [...new Set(scopes)] : current.scopes;

    this.latchedWrite(newScopes.includes(SCOPE_ADMIN), opts, () =>
      this.stmtUpdate.run(newName, JSON.stringify(newScopes), id),
    );

    return {
      ...current,
      name: newName,
      scopes: newScopes,
      revision: current.revision + 1,
    };
  }

  /**
   * Change any of a key's settings in one transaction (PATCH
   * /admin/keys/:id). With `expectedRevision` the write happens only if the
   * key is still at that revision (KeyRevisionMismatchError otherwise).
   * Validates scopes, allowed models and limits before writing anything.
   * Bumps the revision once. Throws KeyNotFoundError.
   */
  patch(id: string, patch: KeyPatch, expectedRevision?: number, opts?: KeyWriteOptions): APIKey {
    if (patch.scopes !== undefined) assertValidScopes(patch.scopes);
    const allowedModels = patch.allowedModels === undefined ? undefined : normalizeAllowedModels(patch.allowedModels);
    assertLimit("quotaTokens", patch.quotaTokens, 0);
    assertLimit("rpm", patch.rpm, 1);
    assertLimit("tpm", patch.tpm, 1);
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (patch.name !== undefined) set("name", patch.name);
    const scopes = patch.scopes !== undefined && patch.scopes.length > 0 ? [...new Set(patch.scopes)] : undefined;
    if (scopes !== undefined) set("scopes", JSON.stringify(scopes));
    if (allowedModels !== undefined)
      set("allowed_models", allowedModels === null ? null : JSON.stringify(allowedModels));
    if (patch.expiresAt !== undefined)
      set("expires_at", patch.expiresAt === null ? null : patch.expiresAt.toISOString());
    if (patch.quotaTokens !== undefined) set("quota_tokens", patch.quotaTokens);
    if (patch.rpm !== undefined) set("rpm", patch.rpm);
    if (patch.tpm !== undefined) set("tpm", patch.tpm);
    return this.latchedWrite(scopes?.includes(SCOPE_ADMIN) === true, opts, () => {
      const current = this.get(id);
      if (current === null) throw new KeyNotFoundError(id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new KeyRevisionMismatchError(current.revision);
      }
      this.db
        .prepare(`UPDATE api_keys SET ${[...sets, "revision = revision + 1"].join(", ")} WHERE id = ?`)
        .run(...args, id);
      const updated = this.get(id);
      if (updated === null) throw new KeyNotFoundError(id);
      return updated;
    });
  }

  /**
   * Set a key's used tokens back to 0 and record when (POST
   * /admin/keys/:id/reset-usage). The running server resets its in-memory
   * counter at the same time. Throws KeyNotFoundError.
   */
  resetUsage(id: string, at: Date = new Date()): APIKey {
    const result = this.db
      .prepare("UPDATE api_keys SET used_tokens = 0, usage_reset_at = ?, revision = revision + 1 WHERE id = ?")
      .run(at.toISOString(), id);
    this.afterWrite();
    if (result.changes === 0) throw new KeyNotFoundError(id);
    const updated = this.get(id);
    if (updated === null) throw new KeyNotFoundError(id);
    return updated;
  }

  /**
   * Persist live used-token counters (absolute values) in one transaction.
   * Called asynchronously by the usage recorder, never on the request path.
   * Keys that no longer exist are skipped.
   */
  saveUsedTokens(entries: Iterable<readonly [id: string, used: number]>): void {
    // Background write (usage recorder timer / shutdown): short busy timeout, the caller retries.
    this.withBusyTimeout(BACKGROUND_BUSY_TIMEOUT_MS, () => {
      const stmt = this.db.query("UPDATE api_keys SET used_tokens = ? WHERE id = ?");
      this.db.transaction(() => {
        for (const [id, used] of entries) stmt.run(Math.max(0, Math.floor(used)), id);
      })();
    });
  }

  /** Persisted used tokens of every key with any usage (restored into the key meter at startup). */
  usedTokensByKey(): Map<string, number> {
    const rows = this.db.query("SELECT id, used_tokens FROM api_keys WHERE used_tokens > 0").all() as Array<{
      id: string;
      used_tokens: number;
    }>;
    return new Map(rows.map((r) => [r.id, r.used_tokens]));
  }

  // -------------------------------------------------------------------------
  // SetExpiration
  // -------------------------------------------------------------------------

  /** Set or clear (null) the expiration. Throws KeyNotFoundError if absent. */
  setExpiration(id: string, expiresAt: Date | null): void {
    const result = this.stmtSetExpiry.run(expiresAt ? expiresAt.toISOString() : null, id);
    this.afterWrite();
    if (result.changes === 0) {
      throw new KeyNotFoundError(id);
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  /** Delete a key by ID. Throws KeyNotFoundError if absent. */
  delete(id: string): void {
    const result = this.stmtDelete.run(id);
    this.pendingUsage.delete(id);
    this.afterWrite();
    if (result.changes === 0) {
      throw new KeyNotFoundError(id);
    }
  }

  // -------------------------------------------------------------------------
  // RotateKey
  // -------------------------------------------------------------------------

  /**
   * Generate a new secret for an existing key. Updates key_hash + key_display
   * + rotated_at. Returns the key with the new plaintext secret.
   */
  rotateKey(id: string): APIKey {
    const newKey = generateAPIKey();
    const now = new Date();

    const result = this.stmtRotate.run(hashKey(newKey), displayKey(newKey), now.toISOString(), id);
    this.afterWrite();
    if (result.changes === 0) {
      throw new KeyNotFoundError(id);
    }

    const updated = this.get(id);
    if (updated === null) {
      // Should not happen — we just updated it.
      throw new KeyNotFoundError(id);
    }

    return {
      ...updated,
      key: newKey,
    };
  }

  // -------------------------------------------------------------------------
  // Ping
  // -------------------------------------------------------------------------

  /** Verify the DB is reachable. Throws if unreachable. */
  ping(): void {
    // A trivial SELECT exercises the connection.
    this.db.query("SELECT 1").get();
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  /** Close the underlying database. Safe to call once. */
  close(): void {
    if (this.closed) return;
    if (this.syncTimer !== undefined) clearInterval(this.syncTimer);
    this.syncTimer = undefined;
    // Last write of the usage counters (best effort; a still-locked database loses them).
    this.flushUsageCounters();
    this.closed = true;
    this.snapshot = null;
    this.db.close();
  }
}
