/**
 * One-way bootstrap latch in the key store: set (in the same transaction)
 * when the first admin-scoped key is stored, never cleared, adopted on
 * upgrade by databases that already hold an admin key, and shared by every
 * connection to the same database file.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootstrapLatchedError, KeyStore, openKeyStoreDatabase } from "@/persistence/key-store";

const open: Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function mem(): Database {
  const db = new Database(":memory:");
  open.push(db);
  return db;
}

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agw-latch-"));
  dirs.push(dir);
  return join(dir, "api-keys.sqlite");
}

/** Turn a current store back into a pre-latch (schema v3) database. */
function downgradeToV3(db: Database): void {
  db.exec("DROP TABLE api_key_meta");
  db.exec("DELETE FROM api_key_schema_migrations WHERE version = 4");
}

function insertRaw(db: Database, id: string, scopes: string[], opts: { revoked?: boolean; expiresAt?: string } = {}) {
  db.prepare(
    `INSERT INTO api_keys(id, key_hash, key_display, name, scopes, created_at, revoked_at, expires_at, rotated_at, active, usage_count, last_used_at)
     VALUES(?, ?, 'sk-...x', ?, ?, ?, ?, ?, NULL, ?, 0, NULL)`,
  ).run(
    id,
    `hash-${id}`,
    id,
    JSON.stringify(scopes),
    new Date().toISOString(),
    opts.revoked ? new Date().toISOString() : null,
    opts.expiresAt ?? null,
    opts.revoked ? 0 : 1,
  );
}

describe("bootstrap latch", () => {
  it("is not set on a fresh store, nor by inference/read_only keys", async () => {
    const store = await KeyStore.create(mem());
    expect(store.isBootstrapLatched()).toBe(false);
    store.create("client", ["inference"]);
    store.create("viewer", ["read_only"]);
    store.create("default", []);
    expect(store.isBootstrapLatched()).toBe(false);
    expect(store.bootstrapLatchedAt()).toBeNull();
  });

  it("is set by the first admin key and survives revoke, expiry and delete", async () => {
    const store = await KeyStore.create(mem());
    const before = Date.now();
    const k = store.create("admin", ["admin"], new Date(Date.now() + 1000));
    const at = store.bootstrapLatchedAt();
    expect(at).not.toBeNull();
    expect(at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    store.revoke(k.id);
    store.setExpiration(k.id, new Date(Date.now() - 1000));
    store.delete(k.id);
    expect(store.isEmpty()).toBe(true);
    expect(store.isBootstrapLatched()).toBe(true);
    // A second admin key does not move the timestamp.
    store.create("admin2", ["admin", "read_only"]);
    expect(store.bootstrapLatchedAt()!.toISOString()).toBe(at!.toISOString());
  });

  it("is set by update() granting admin", async () => {
    const store = await KeyStore.create(mem());
    const k = store.create("client", ["inference"]);
    store.update(k.id, "renamed", []);
    expect(store.isBootstrapLatched()).toBe(false);
    store.update(k.id, "", ["admin"]);
    expect(store.isBootstrapLatched()).toBe(true);
  });

  it("persists across reopen", async () => {
    const path = tmpDbPath();
    const a = await KeyStore.create(openKeyStoreDatabase(path));
    a.create("admin", ["admin"]);
    a.close();
    const b = await KeyStore.create(openKeyStoreDatabase(path));
    expect(b.isBootstrapLatched()).toBe(true);
    b.close();
  });

  it("a latch set through another connection (e.g. the CLI) is seen", async () => {
    const path = tmpDbPath();
    const server = await KeyStore.create(openKeyStoreDatabase(path));
    const cli = await KeyStore.create(openKeyStoreDatabase(path));
    expect(server.isBootstrapLatched()).toBe(false);
    cli.create("recovered", ["admin"]);
    expect(server.isBootstrapLatched()).toBe(true);
    server.close();
    cli.close();
  });

  it("requireUnlatched: refuses (and writes nothing) once latched, across connections", async () => {
    const path = tmpDbPath();
    const a = await KeyStore.create(openKeyStoreDatabase(path));
    const b = await KeyStore.create(openKeyStoreDatabase(path));
    a.create("first", ["admin"], undefined, { requireUnlatched: true });
    expect(() => b.create("second", ["admin"], undefined, { requireUnlatched: true })).toThrow(BootstrapLatchedError);
    expect(() => b.create("client", ["inference"], undefined, { requireUnlatched: true })).toThrow(
      BootstrapLatchedError,
    );
    const k = b.create("client", ["inference"]);
    expect(() => b.update(k.id, "", ["admin"], { requireUnlatched: true })).toThrow(BootstrapLatchedError);
    expect(b.get(k.id)!.scopes).toEqual(["inference"]);
    expect(
      b
        .list()
        .map((x) => x.name)
        .sort(),
    ).toEqual(["client", "first"]);
    a.close();
    b.close();
  });

  it("a failed insert does not set the latch (same transaction)", async () => {
    const db = mem();
    const store = await KeyStore.create(db);
    db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON api_keys BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => store.create("admin", ["admin"])).toThrow(/disk full/);
    expect(store.isBootstrapLatched()).toBe(false);
  });
});

describe("bootstrap latch migration (v4) on existing databases", () => {
  for (const [label, opts] of [
    ["active", {}],
    ["revoked", { revoked: true }],
    ["expired", { expiresAt: "2000-01-01T00:00:00.000Z" }],
  ] as const) {
    it(`a database with an ${label} admin key is latched on upgrade`, async () => {
      const db = mem();
      await KeyStore.create(db);
      downgradeToV3(db);
      insertRaw(db, "client", ["inference"]);
      insertRaw(db, "old-admin", ["read_only", "admin"], opts);
      const store = await KeyStore.create(db);
      expect(store.isBootstrapLatched()).toBe(true);
    });
  }

  it("a database without admin keys is not latched on upgrade", async () => {
    const db = mem();
    await KeyStore.create(db);
    downgradeToV3(db);
    insertRaw(db, "client", ["inference"]);
    insertRaw(db, "viewer", ["read_only"]);
    insertRaw(db, "broken", []);
    db.prepare("UPDATE api_keys SET scopes = 'not json' WHERE id = 'broken'").run();
    const store = await KeyStore.create(db);
    expect(store.isBootstrapLatched()).toBe(false);
    const versions = db.query("SELECT version FROM api_key_schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });

  it("re-running migrations is a no-op", async () => {
    const db = mem();
    const a = await KeyStore.create(db);
    a.create("admin", ["admin"]);
    const at = a.bootstrapLatchedAt()!.toISOString();
    const b = await KeyStore.create(db);
    expect(b.bootstrapLatchedAt()!.toISOString()).toBe(at);
  });
});
