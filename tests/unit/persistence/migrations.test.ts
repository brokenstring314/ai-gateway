import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import {
  runMigrations,
  MigrationStep,
  MigrationError,
  DeferredStepError,
} from "@/persistence/migrations";

describe("Migration runner", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe("validateSteps", () => {
    it("rejects empty steps array", async () => {
      await expect(runMigrations(db, [])).rejects.toThrow(MigrationError);
      await expect(runMigrations(db, [])).rejects.toThrow(
        "No migration steps provided",
      );
    });

    it("rejects step with empty name", async () => {
      const steps: MigrationStep[] = [
        { version: 1, name: "  ", sql: "SELECT 1" },
      ];
      await expect(runMigrations(db, steps)).rejects.toThrow(
        "has an empty name",
      );
    });

    it("rejects step with no action (no sql/fn/noTx)", async () => {
      const steps: MigrationStep[] = [
        { version: 1, name: "no-action" },
      ];
      await expect(runMigrations(db, steps)).rejects.toThrow("has no action");
    });

    it("rejects step with multiple actions", async () => {
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "multi-action",
          sql: "SELECT 1",
          fn: () => {},
        },
      ];
      await expect(runMigrations(db, steps)).rejects.toThrow(
        "has multiple actions",
      );
    });

    it("rejects non-ascending versions", async () => {
      const steps: MigrationStep[] = [
        { version: 2, name: "second", sql: "SELECT 1" },
        { version: 1, name: "first", sql: "SELECT 1" },
      ];
      await expect(runMigrations(db, steps)).rejects.toThrow(
        "not strictly ascending",
      );
    });

    it("rejects duplicate versions", async () => {
      const steps: MigrationStep[] = [
        { version: 1, name: "first", sql: "SELECT 1" },
        { version: 1, name: "duplicate", sql: "SELECT 1" },
      ];
      await expect(runMigrations(db, steps)).rejects.toThrow(
        "not strictly ascending",
      );
    });

    it("rejects version < 1", async () => {
      const steps: MigrationStep[] = [
        { version: 0, name: "zero", sql: "SELECT 1" },
      ];
      await expect(runMigrations(db, steps)).rejects.toThrow(
        "versions must be >= 1",
      );
    });
  });

  // -----------------------------------------------------------------------
  // Core migration flow
  // -----------------------------------------------------------------------

  describe("runMigrations", () => {
    it("runs all steps on empty DB", async () => {
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "create_users",
          sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
        },
        {
          version: 2,
          name: "create_posts",
          sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)",
        },
      ];

      await runMigrations(db, steps);

      // Both tables should exist
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((r) => r.name);
      expect(tableNames).toContain("users");
      expect(tableNames).toContain("posts");

      // Ledger should have both versions
      const rows = db
        .query("SELECT version, name FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number; name: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.version).toBe(1);
      expect(rows[0]!.name).toBe("create_users");
      expect(rows[1]!.version).toBe(2);
      expect(rows[1]!.name).toBe("create_posts");
    });

    it("runs only remaining steps on partially-migrated DB", async () => {
      // Pre-apply version 1
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "create_users",
          sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
        },
      ];
      await runMigrations(db, steps);

      // Now add version 2
      const allSteps: MigrationStep[] = [
        {
          version: 1,
          name: "create_users",
          sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
        },
        {
          version: 2,
          name: "create_posts",
          sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)",
        },
      ];
      await runMigrations(db, allSteps);

      // Version 1 should not be re-applied
      const rows = db
        .query("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      // Only one row for v1 (not duplicated) and one for v2
      const v1Rows = rows.filter((r) => r.version === 1);
      expect(v1Rows).toHaveLength(1);
      expect(rows).toHaveLength(2);

      // Posts table should exist
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'")
        .all();
      expect(tables).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Baseline adoption
  // -----------------------------------------------------------------------

  describe("baseline adoption", () => {
    it("skips step[0] when primaryTable already exists and ledger is empty", async () => {
      // Create the primary table manually (simulating pre-existing DB)
      db.exec("CREATE TABLE requests (id INTEGER PRIMARY KEY)");

      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "create_requests",
          sql: "CREATE TABLE requests (id INTEGER PRIMARY KEY, body TEXT)",
        },
        {
          version: 2,
          name: "add_body_column",
          sql: "ALTER TABLE requests ADD COLUMN body TEXT",
        },
      ];

      await runMigrations(db, steps, { primaryTable: "requests" });

      // Version 1 should be recorded but not re-executed
      // (the table already existed, so the CREATE TABLE would fail if re-run)
      const rows = db
        .query("SELECT version, name FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number; name: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.version).toBe(1);
      expect(rows[0]!.name).toBe("create_requests");
      expect(rows[1]!.version).toBe(2);
      expect(rows[1]!.name).toBe("add_body_column");

      // The body column should have been added by v2
      const cols = db
        .query("PRAGMA table_info(requests)")
        .all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("body");
    });

    it("does not adopt baseline when primaryTable does not exist", async () => {
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "create_requests",
          sql: "CREATE TABLE requests (id INTEGER PRIMARY KEY)",
        },
      ];

      await runMigrations(db, steps, { primaryTable: "requests" });

      // Table should be created normally
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='requests'")
        .all();
      expect(tables).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // checkNotAhead
  // -----------------------------------------------------------------------

  describe("checkNotAhead", () => {
    it("errors when DB has a version this build does not know", async () => {
      // Apply v1 and v2
      const stepsV2: MigrationStep[] = [
        {
          version: 1,
          name: "create_users",
          sql: "CREATE TABLE users (id INTEGER PRIMARY KEY)",
        },
        {
          version: 2,
          name: "create_posts",
          sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY)",
        },
      ];
      await runMigrations(db, stepsV2);

      // Now try running with only v1 known (simulating a downgrade)
      const stepsV1: MigrationStep[] = [
        {
          version: 1,
          name: "create_users",
          sql: "CREATE TABLE users (id INTEGER PRIMARY KEY)",
        },
      ];
      await expect(runMigrations(db, stepsV1)).rejects.toThrow(
        "version 2 which this build does not know",
      );
    });
  });

  // -----------------------------------------------------------------------
  // SQL step execution
  // -----------------------------------------------------------------------

  describe("SQL step", () => {
    it("executes SQL and records in ledger", async () => {
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "create_items",
          sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
        },
      ];

      await runMigrations(db, steps);

      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='items'")
        .all();
      expect(tables).toHaveLength(1);

      const ledger = db
        .query("SELECT version, name FROM schema_migrations")
        .all() as Array<{ version: number; name: string }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.version).toBe(1);
      expect(ledger[0]!.name).toBe("create_items");
    });
  });

  // -----------------------------------------------------------------------
  // Fn step execution
  // -----------------------------------------------------------------------

  describe("Fn step", () => {
    it("executes fn and records in ledger", async () => {
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "seed_data",
          fn: (dbArg, _tx) => {
            dbArg.exec(
              "CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)",
            );
            dbArg.exec(
              "INSERT INTO config (key, value) VALUES ('version', '1')",
            );
          },
        },
      ];

      await runMigrations(db, steps);

      const row = db
        .query("SELECT value FROM config WHERE key = 'version'")
        .get() as { value: string } | null;
      expect(row).not.toBeNull();
      expect(row!.value).toBe("1");

      const ledger = db
        .query("SELECT version, name FROM schema_migrations")
        .all() as Array<{ version: number; name: string }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.name).toBe("seed_data");
    });
  });

  // -----------------------------------------------------------------------
  // NoTx step execution
  // -----------------------------------------------------------------------

  describe("NoTx step", () => {
    it("executes outside transaction and records in ledger", async () => {
      // Create a table first so we can VACUUM
      db.exec("CREATE TABLE dummy (id INTEGER PRIMARY KEY)");

      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "vacuum_db",
          noTx: (dbArg) => {
            dbArg.exec("VACUUM");
          },
        },
      ];

      await runMigrations(db, steps);

      const ledger = db
        .query("SELECT version, name FROM schema_migrations")
        .all() as Array<{ version: number; name: string }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.name).toBe("vacuum_db");
    });
  });

  // -----------------------------------------------------------------------
  // DeferredStepError
  // -----------------------------------------------------------------------

  describe("DeferredStepError", () => {
    it("skips recording deferred step and continues with later steps", async () => {
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "create_table",
          sql: "CREATE TABLE items (id INTEGER PRIMARY KEY)",
        },
        {
          version: 2,
          name: "deferred_step",
          fn: () => {
            throw new DeferredStepError("not ready yet");
          },
        },
        {
          version: 3,
          name: "add_column",
          sql: "ALTER TABLE items ADD COLUMN value TEXT",
        },
      ];

      await runMigrations(db, steps);

      // v      // v1 and v3 should be recorded; v2 should not
      const rows = db
        .query("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      const versions = rows.map((r) => r.version);
      expect(versions).toContain(1);
      expect(versions).not.toContain(2);
      expect(versions).toContain(3);

      // The column from v3 should exist
      const cols = db
        .query("PRAGMA table_info(items)")
        .all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("value");
    });
  });

  // -----------------------------------------------------------------------
  // Custom ledger table name
  // -----------------------------------------------------------------------

  describe("custom ledger name", () => {
    it("uses custom ledger table name when provided", async () => {
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "create_items",
          sql: "CREATE TABLE items (id INTEGER PRIMARY KEY)",
        },
      ];

      await runMigrations(db, steps, { ledger: "my_migrations" });

      // Default ledger should NOT exist
      const defaultLedger = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .all();
      expect(defaultLedger).toHaveLength(0);

      // Custom ledger should exist
      const customLedger = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='my_migrations'")
        .all();
      expect(customLedger).toHaveLength(1);

      const rows = db
        .query("SELECT version FROM my_migrations")
        .all() as Array<{ version: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.version).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  describe("idempotency", () => {
    it("is safe to call runMigrations multiple times", async () => {
      const steps: MigrationStep[] = [
        {
          version: 1,
          name: "create_items",
          sql: "CREATE TABLE items (id INTEGER PRIMARY KEY)",
        },
      ];

      await runMigrations(db, steps);
      await runMigrations(db, steps);
      await runMigrations(db, steps);

      const rows = db
        .query("SELECT version FROM schema_migrations")
        .all() as Array<{ version: number }>;
      expect(rows).toHaveLength(1);
    });
  });
});
