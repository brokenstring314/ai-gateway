import type { Database } from "bun:sqlite";
import {
  runMigrations,
  type MigrationStep,
} from "@/persistence/migrations";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cap on history rows returned by LoadHistory. Read bound only — never deletes. */
const maxConfigHistoryEntries = 100;

/** Migration ledger name, distinct from the key store's ledger. */
const configLedger = "config_schema_migrations";

// ---------------------------------------------------------------------------
// Migration steps (matching Go's configStoreSteps)
// ---------------------------------------------------------------------------

const configStoreSteps: MigrationStep[] = [
  {
    version: 1,
    name: "gateway_config_baseline",
    sql: `
CREATE TABLE IF NOT EXISTS gateway_config (
  id INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL
);`,
  },
  {
    version: 2,
    name: "config_history",
    sql: `
CREATE TABLE IF NOT EXISTS config_history (
  version INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL
);`,
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One durable config_history record: a config snapshot and the version/time at
 *  which it became the active config. */
export interface PersistedConfigVersion {
  version: number;
  configJson: string;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

/** Persists gateway config snapshots in SQLite via bun:sqlite. */
export class ConfigStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    // Synchronous — runMigrations is async but bun:sqlite steps are sync.
    // We cannot await in a constructor, so we use a void return and rely on
    // the caller using the static `create` factory for the async path.
  }

  /** Async factory: runs migrations before returning the store. */
  static async create(db: Database): Promise<ConfigStore> {
    const store = new ConfigStore(db);
    await runMigrations(db, configStoreSteps, {
      ledger: configLedger,
      primaryTable: "gateway_config",
    });
    return store;
  }

  // -----------------------------------------------------------------------
  // Save — atomic upsert + history append
  // -----------------------------------------------------------------------

  /** Persists config and appends to history ATOMICALLY in one transaction.
   *  This guarantees active config and audit trail never diverge. */
  save(configJson: string): void {
    const now = new Date().toISOString();

    this.db.transaction(() => {
      // Upsert the active config (single-row, always id=1).
      this.db
        .prepare(
          `INSERT INTO gateway_config(id, config_json, updated_at)
           VALUES(1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
        )
        .run(configJson, now);

      // Auto-increment history version.
      const nextVersion = this.db
        .prepare(
          "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM config_history",
        )
        .get() as { v: number } | null;

      this.db
        .prepare(
          "INSERT INTO config_history(version, config_json, updated_at) VALUES(?, ?, ?)",
        )
        .run(nextVersion!.v, configJson, now);
    })();
  }

  // -----------------------------------------------------------------------
  // Load
  // -----------------------------------------------------------------------

  /** Returns the persisted config JSON string, or null if none exists. */
  load(): string | null {
    const row = this.db
      .prepare("SELECT config_json FROM gateway_config WHERE id = 1")
      .get() as { config_json: string } | null;

    if (row === null) {
      return null;
    }
    return row.config_json;
  }

  // -----------------------------------------------------------------------
  // LoadHistory
  // -----------------------------------------------------------------------

  /** Returns config versions in ascending version order (newest last).
   *  Capped at maxConfigHistoryEntries. */
  loadHistory(): PersistedConfigVersion[] {
    const rows = this.db
      .prepare(
        "SELECT version, config_json, updated_at FROM config_history ORDER BY version DESC LIMIT ?",
      )
      .all(maxConfigHistoryEntries) as Array<{
      version: number;
      config_json: string;
      updated_at: string;
    }>;

    // Rows arrive newest-first (DESC); reverse to ascending.
    const history: PersistedConfigVersion[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      history.push({
        version: r.version,
        configJson: r.config_json,
        updatedAt: new Date(r.updated_at),
      });
    }
    return history;
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  /** Removes the persisted config snapshot (reverts to file config). */
  delete(): void {
    this.db.prepare("DELETE FROM gateway_config WHERE id = 1").run();
  }

  // -----------------------------------------------------------------------
  // Ping
  // -----------------------------------------------------------------------

  /** Verifies DB is reachable. */
  ping(): void {
    // bun:sqlite doesn't have a separate ping — a simple query suffices.
    this.db.query("SELECT 1").get();
  }

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  /** Closes the database. */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// GatewayConfigManager
// ---------------------------------------------------------------------------

/** Connects runtime gateway config operations to optional persistent storage.
 *  Serializes mutations so persisting a config and applying it are a single step. */
export class GatewayConfigManager {
  private mu: { locked: boolean } = { locked: false };
  private store: ConfigStore | null;
  private currentConfig: string;
  private initialConfig: string;

  constructor(store: ConfigStore | null, initialConfig: string) {
    this.store = store;
    this.initialConfig = initialConfig;
    this.currentConfig = initialConfig;

    // If a store is provided, adopt any persisted config.
    if (store !== null) {
      const persisted = store.load();
      if (persisted !== null) {
        this.currentConfig = persisted;
      }
    }
  }

  /** Returns the current active config. */
  getConfig(): string {
    return this.currentConfig;
  }

  /** Validates, persists, and applies config atomically.
   *  If apply fails after persist, attempts rollback of persisted state.
   *
   *  The `apply` callback is called with the new config to apply it to the
   *  gateway runtime. If it throws, the manager rolls back the persisted state. */
  reloadConfig(
    configJson: string,
    apply: (configJson: string) => void,
  ): void {
    // Serialize mutations.
    this.acquireLock();
    try {
      const previousConfig = this.currentConfig;

      if (this.store !== null) {
        this.store.save(configJson);
      }

      try {
        apply(configJson);
        this.currentConfig = configJson;
      } catch (applyErr) {
        // Save happened before apply. If apply fails, attempt to restore
        // persisted state so runtime and storage remain aligned.
        if (this.store !== null) {
          this.store.save(previousConfig);
        }
        throw applyErr;
      }
    } finally {
      this.releaseLock();
    }
  }

  /** Restores startup config and clears persisted overrides.
   *  If delete fails, saves initial config to keep runtime and storage aligned. */
  resetConfig(apply: (configJson: string) => void): void {
    this.acquireLock();
    try {
      apply(this.initialConfig);
      this.currentConfig = this.initialConfig;

      if (this.store !== null) {
        try {
          this.store.delete();
        } catch (deleteErr) {
          // The apply already succeeded, so the gateway is running the
          // startup config while the store still holds the override.
          // Record what is actually running instead, so the two agree.
          this.store.save(this.initialConfig);
          throw deleteErr;
        }
      }
    } finally {
      this.releaseLock();
    }
  }

  /** Ping — succeeds if no store, or delegates to store ping. */
  ping(): void {
    if (this.store !== null) {
      this.store.ping();
    }
  }

  /** Close — delegates to store if present. */
  close(): void {
    if (this.store !== null) {
      this.store.close();
    }
  }

  // -----------------------------------------------------------------------
  // Simple mutex
  // -----------------------------------------------------------------------

  private acquireLock(): void {
    if (this.mu.locked) {
      throw new Error("GatewayConfigManager: concurrent mutation detected");
    }
    this.mu.locked = true;
  }

  private releaseLock(): void {
    this.mu.locked = false;
  }
}
