import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ConfigStore, GatewayConfigManager } from "@/persistence/config-store";

describe("ConfigStore", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // Helper: create store with migrations applied.
  async function makeStore(db: Database): Promise<ConfigStore> {
    return ConfigStore.create(db);
  }

  // -----------------------------------------------------------------------
  // Migrations
  // -----------------------------------------------------------------------

  it("runs migrations on fresh DB → both tables exist", async () => {
    await makeStore(db);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((r) => r.name);

    expect(tableNames).toContain("gateway_config");
    expect(tableNames).toContain("config_history");
    expect(tableNames).toContain("config_schema_migrations");
  });

  // -----------------------------------------------------------------------
  // Save + Load
  // -----------------------------------------------------------------------

  it("save config → load returns same JSON", async () => {
    const store = await makeStore(db);
    const cfg = '{"strategy":{"mode":"single"}}';
    store.save(cfg);

    expect(store.load()).toBe(cfg);
  });

  it("save twice → load returns latest", async () => {
    const store = await makeStore(db);
    const first = '{"strategy":{"mode":"single"}}';
    const second = '{"strategy":{"mode":"fallback"}}';

    store.save(first);
    store.save(second);

    expect(store.load()).toBe(second);
  });

  // -----------------------------------------------------------------------
  // History
  // -----------------------------------------------------------------------

  it("save → loadHistory has one entry", async () => {
    const store = await makeStore(db);
    const cfg = '{"strategy":{"mode":"single"}}';
    store.save(cfg);

    const history = store.loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.configJson).toBe(cfg);
    expect(history[0]!.version).toBe(1);
    expect(history[0]!.updatedAt).toBeInstanceOf(Date);
  });

  it("save multiple times → loadHistory grows", async () => {
    const store = await makeStore(db);
    store.save('{"v":1}');
    store.save('{"v":2}');
    store.save('{"v":3}');

    const history = store.loadHistory();
    expect(history).toHaveLength(3);
  });

  it("loadHistory returns ascending version order", async () => {
    const store = await makeStore(db);
    for (let i = 1; i <= 5; i++) {
      store.save(`{"v":${i}}`);
    }

    const history = store.loadHistory();
    expect(history).toHaveLength(5);

    for (let i = 0; i < history.length; i++) {
      expect(history[i]!.version).toBe(i + 1);
    }
  });

  it("loadHistory capped at maxConfigHistoryEntries (100)", async () => {
    const store = await makeStore(db);

    // Seed 150 entries directly into config_history.
    const now = new Date().toISOString();
    for (let v = 1; v <= 150; v++) {
      db.prepare(
        "INSERT INTO config_history(version, config_json, updated_at) VALUES(?, ?, ?)",
      ).run(v, `{"v":${v}}`, now);
    }

    const history = store.loadHistory();
    expect(history).toHaveLength(100);

    // Should return the newest 100 (versions 51..150), ascending.
    expect(history[0]!.version).toBe(51);
    expect(history[history.length - 1]!.version).toBe(150);

    // The cap is a read bound, not a retention policy — nothing deleted.
    const count = db
      .query("SELECT COUNT(*) as c FROM config_history")
      .get() as { c: number };
    expect(count.c).toBe(150);
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  it("delete config → load returns null", async () => {
    const store = await makeStore(db);
    store.save('{"v":1}');

    store.delete();

    expect(store.load()).toBeNull();
  });

  it("delete on empty DB → no error", async () => {
    const store = await makeStore(db);

    expect(() => store.delete()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Atomicity
  // -----------------------------------------------------------------------

  it("save atomicity: both config + history written together", async () => {
    const store = await makeStore(db);
    const cfg = '{"strategy":{"mode":"fallback"}}';
    store.save(cfg);

    // Both the active config and history should reflect the save.
    expect(store.load()).toBe(cfg);

    const history = store.loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.configJson).toBe(cfg);
  });

  it("save rolls back config when history insert fails", async () => {
    const store = await makeStore(db);

    // Save once successfully.
    const first = '{"v":1}';
    store.save(first);
    expect(store.load()).toBe(first);

    // Drop config_history so the second save's history step fails.
    db.exec("DROP TABLE config_history");

    // The save should fail (transaction rolls back).
    expect(() => store.save('{"v":2}')).toThrow();

    // The active config must still be the first one — rollback worked.
    expect(store.load()).toBe(first);
  });

  // -----------------------------------------------------------------------
  // Ping
  // -----------------------------------------------------------------------

  it("ping → succeeds on open DB", async () => {
    const store = await makeStore(db);
    expect(() => store.ping()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  it("re-open store → migrations idempotent", async () => {
    // Use a file DB so we can re-open the same database.
    const path = `${import.meta.dir}/.test-config-${Date.now()}.db`;
    const db1 = new Database(path);
    const store1 = await ConfigStore.create(db1);
    store1.save('{"v":1}');
    store1.close();

    // Re-open the same file.
    const db2 = new Database(path);
    const store2 = await ConfigStore.create(db2);

    // Migrations should not re-run or error.
    const rows = db2
      .query("SELECT version FROM config_schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(rows).toHaveLength(2);

    // Data persists.
    expect(store2.load()).toBe('{"v":1}');
    store2.close();

    // Cleanup.
    const fs = await import("node:fs");
    fs.unlinkSync(path);
  });
});

// ---------------------------------------------------------------------------
// GatewayConfigManager
// ---------------------------------------------------------------------------

describe("GatewayConfigManager", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  async function makeStore(db: Database): Promise<ConfigStore> {
    return ConfigStore.create(db);
  }

  it("save + load roundtrip via manager", async () => {
    const store = await makeStore(db);
    const initial = '{"mode":"single"}';
    const mgr = new GatewayConfigManager(store, initial);

    // Manager adopts persisted config (none yet) → returns initial.
    expect(mgr.getConfig()).toBe(initial);

    // Reload to a new config.
    const next = '{"mode":"fallback"}';
    mgr.reloadConfig(next, (cfg) => {
      // Simulate applying the config — the manager handles persistence.
    });

    expect(mgr.getConfig()).toBe(next);
    expect(store.load()).toBe(next);
  });

  it("reset restores initial config", async () => {
    const store = await makeStore(db);
    const initial = '{"mode":"single"}';
    const mgr = new GatewayConfigManager(store, initial);

    // Reload to a different config.
    mgr.reloadConfig('{"mode":"fallback"}', () => {});
    expect(mgr.getConfig()).toBe('{"mode":"fallback"}');
    expect(store.load()).toBe('{"mode":"fallback"}');

    // Reset to initial.
    mgr.resetConfig(() => {});
    expect(mgr.getConfig()).toBe(initial);

    // Persisted override should be deleted.
    expect(store.load()).toBeNull();
  });

  it("ping with no store → succeeds", () => {
    const mgr = new GatewayConfigManager(null, '{"mode":"single"}');
    expect(() => mgr.ping()).not.toThrow();
  });

  it("ping with store → delegates to store", async () => {
    const store = await makeStore(db);
    const mgr = new GatewayConfigManager(store, '{"mode":"single"}');
    expect(() => mgr.ping()).not.toThrow();
  });

  it("reloadConfig rollback on apply failure", async () => {
    const store = await makeStore(db);
    const initial = '{"mode":"single"}';
    const mgr = new GatewayConfigManager(store, initial);

    // The apply callback throws — the persisted state should be rolled back.
    expect(() => {
      mgr.reloadConfig('{"mode":"fallback"}', () => {
        throw new Error("apply failed");
      });
    }).toThrow("apply failed");

    // Runtime config unchanged.
    expect(mgr.getConfig()).toBe(initial);
    // Persisted config rolled back to previous.
    expect(store.load()).toBe(initial);
  });

  it("resetConfig with no store → applies initial", () => {
    const mgr = new GatewayConfigManager(null, '{"mode":"single"}');

    // Change config via reload.
    mgr.reloadConfig('{"mode":"fallback"}', () => {});
    expect(mgr.getConfig()).toBe('{"mode":"fallback"}');

    // Reset.
    mgr.resetConfig(() => {});
    expect(mgr.getConfig()).toBe('{"mode":"single"}');
  });

  it("adopts persisted config at construction", async () => {
    const store = await makeStore(db);
    const persisted = '{"mode":"fallback"}';
    store.save(persisted);

    const initial = '{"mode":"single"}';
    const mgr = new GatewayConfigManager(store, initial);

    // Should adopt the persisted config, not the initial.
    expect(mgr.getConfig()).toBe(persisted);
  });
});
