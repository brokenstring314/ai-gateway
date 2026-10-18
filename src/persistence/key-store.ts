/**
 * KeyStore — SQLite-backed API key persistence.
 *
 * Matches the Go SQLStore (internal/admin/sql_store.go):
 *   - 3-step migration sequence via the migration runner
 *   - prepared statements cached on the store instance
 *   - SHA-256 hash lookup (plaintext key never stored)
 *   - non-fatal usage-counter update on ValidateKey
 *   - timing-safe hash comparison via timingSafeEqual
 */

import { Database, Statement } from "bun:sqlite";
import {
  hashKey,
  displayKey,
  generateAPIKey,
  generateID,
  timingSafeEqual,
} from "@/auth/key-hash";
import {
  runMigrations,
  type MigrationStep,
} from "@/persistence/migrations";

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

const KEY_ROW_SELECT =
  "SELECT id, key_display, name, scopes, created_at, revoked_at, expires_at, rotated_at, active, usage_count, last_used_at FROM api_keys";

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
        const cols = db
          .query("PRAGMA table_info(api_keys)")
          .all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        if (!names.has("key_hash") || !names.has("key_display")) {
          throw new Error(
            "api_keys table missing key_hash or key_display columns",
          );
        }
      },
    },
    {
      version: 3,
      name: "api_keys_scrub",
      noTx: (db) => {
        db.exec("VACUUM");
        const row = db
          .query("PRAGMA wal_checkpoint(TRUNCATE)")
          .get() as [number, number, number] | null;
        if (row !== null && row[0] !== 0 && row[1] > 0) {
          console.warn(
            `api_keys_scrub: wal_checkpoint busy, ${row[1]} frames left unmerged`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Row shape from SQLite (raw, before parsing into APIKey)
// ---------------------------------------------------------------------------

interface KeyRow {
  id: string;
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
  };
}

// ---------------------------------------------------------------------------
// KeyStore
// ---------------------------------------------------------------------------

export class KeyStore {
  private readonly db: Database;
  private stmtGetByID!: Statement<KeyRow, [string]>;
  private stmtGetByHash!: Statement<KeyRow, [string]>;
  private stmtRevoke!: Statement<unknown, [string, number, string]>;
  private stmtUpdate!: Statement<unknown, [string, string, string]>;
  private stmtSetExpiry!: Statement<unknown, [string | null, string]>;
  private stmtDelete!: Statement<unknown, [string]>;
  private stmtUsage!: Statement<unknown, [string, string]>;
  private stmtRotate!: Statement<unknown, [string, string, string, string]>;

  private constructor(db: Database) {
    this.db = db;
  }

  static async create(db: Database): Promise<KeyStore> {
    const store = new KeyStore(db);
    await runMigrations(db, keyStoreSteps(), {
      ledger: LEDGER,
      primaryTable: PRIMARY_TABLE,
    });
    store.initStatements();
    return store;
  }

  private initStatements(): void {
    this.stmtGetByID = this.db.prepare<KeyRow, [string]>(`${KEY_ROW_SELECT} WHERE id = ?`);
    this.stmtGetByHash = this.db.prepare<KeyRow, [string]>(
      `${KEY_ROW_SELECT} WHERE key_hash = ?`,
    );
    this.stmtRevoke = this.db.prepare(
      "UPDATE api_keys SET revoked_at = ?, active = ? WHERE id = ?",
    );
    this.stmtUpdate = this.db.prepare(
      "UPDATE api_keys SET name = ?, scopes = ? WHERE id = ?",
    );
    this.stmtSetExpiry = this.db.prepare(
      "UPDATE api_keys SET expires_at = ? WHERE id = ?",
    );
    this.stmtDelete = this.db.prepare("DELETE FROM api_keys WHERE id = ?");
    this.stmtUsage = this.db.prepare(
      "UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?",
    );
    this.stmtRotate = this.db.prepare(
      "UPDATE api_keys SET key_hash = ?, key_display = ?, rotated_at = ? WHERE id = ?",
    );
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Generate a new API key. The full secret is returned; only the hash and
   * display form are persisted. Empty scopes default to ["inference"]
   * (inference only); admin access must be requested explicitly. Throws
   * InvalidScopeError for an unknown scope.
   */
  create(name: string, scopes: string[], expiresAt?: Date): APIKey {
    assertValidScopes(scopes);
    const finalScopes = scopes.length > 0 ? [...new Set(scopes)] : [...DEFAULT_SCOPES];
    const key = generateAPIKey();
    const id = generateID();
    const now = new Date();

    this.db
      .prepare(
        `INSERT INTO api_keys(id, key_hash, key_display, name, scopes, created_at, revoked_at, expires_at, rotated_at, active, usage_count, last_used_at)
         VALUES(?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL)`,
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
    };
  }

  // -------------------------------------------------------------------------
  // IsEmpty
  // -------------------------------------------------------------------------

  /** Returns true if no API keys exist. Stops at the first row. */
  isEmpty(): boolean {
    const row = this.db
      .query("SELECT 1 FROM api_keys LIMIT 1")
      .get() as { "1": number } | null;
    return row === null;
  }

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------

  get(id: string): APIKey | null {
    const row = this.stmtGetByID.get(id);
    if (row === null) return null;
    return parseRow(row);
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  list(): APIKey[] {
    const rows = this.db.query<KeyRow, []>(KEY_ROW_SELECT).all();
    return rows.map(parseRow);
  }

  // -------------------------------------------------------------------------
  // ValidateKey
  // -------------------------------------------------------------------------

  /**
   * Hash the provided key, look up by hash (timing-safe comparison), check
   * active/revoked/expiry. On success, increment usage_count + update
   * last_used_at (non-fatal if the counter update fails — log and still
   * return the authenticated key).
   *
   * Returns the APIKey (with plaintext key replaced by display form) on
   * success, null on failure.
   */
  validateKey(key: string): APIKey | null {
    if (key === "") return null;

    const hash = hashKey(key);
    const row = this.stmtGetByHash.get(hash);
    if (row === null) return null;

    // Timing-safe comparison — never use === for hash equality.
    if (!timingSafeEqual(hash, hashKey(key))) return null;

    const apiKey = parseRow(row);

    if (!apiKey.active || apiKey.revokedAt !== null) return null;
    if (apiKey.expiresAt !== null && new Date() > apiKey.expiresAt) {
      return null;
    }

    // Auth check passed. Update usage counters; failure is non-fatal.
    const now = new Date();
    try {
      this.stmtUsage.run(now.toISOString(), apiKey.id);
      apiKey.usageCount += 1;
      apiKey.lastUsedAt = now;
    } catch (err) {
      console.warn(
        `failed to update key usage counter; authentication still succeeds — key_id=${apiKey.id} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return apiKey;
  }

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  /** Set active=false + revoked_at=now. Throws KeyNotFoundError if absent. */
  revoke(id: string): void {
    const now = new Date();
    const result = this.stmtRevoke.run(now.toISOString(), 0, id);
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
  update(id: string, name: string, scopes: string[]): APIKey {
    assertValidScopes(scopes);
    const current = this.get(id);
    if (current === null) {
      throw new KeyNotFoundError(id);
    }

    const newName = name !== "" ? name : current.name;
    const newScopes = scopes.length > 0 ? [...new Set(scopes)] : current.scopes;

    this.stmtUpdate.run(newName, JSON.stringify(newScopes), id);

    return {
      ...current,
      name: newName,
      scopes: newScopes,
    };
  }

  // -------------------------------------------------------------------------
  // SetExpiration
  // -------------------------------------------------------------------------

  /** Set or clear (null) the expiration. Throws KeyNotFoundError if absent. */
  setExpiration(id: string, expiresAt: Date | null): void {
    const result = this.stmtSetExpiry.run(
      expiresAt ? expiresAt.toISOString() : null,
      id,
    );
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

    const result = this.stmtRotate.run(
      hashKey(newKey),
      displayKey(newKey),
      now.toISOString(),
      id,
    );
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
    this.db.close();
  }
}
