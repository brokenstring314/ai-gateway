import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { KeyStore, KeyNotFoundError } from "@/persistence/key-store";
import { hashKey } from "@/auth/key-hash";

describe("KeyStore", () => {
  let db: Database;
  let store: KeyStore;

  beforeEach(async () => {
    db = new Database(":memory:");
    store = await KeyStore.create(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------------

  it("fresh DB → migrations run → table exists", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe("api_keys");

    // Ledger should exist too
    const ledgers = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='api_key_schema_migrations'")
      .all() as Array<{ name: string }>;
    expect(ledgers).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  it("create key → returns key with fgw_ prefix", () => {
    const apiKey = store.create("test-key", []);
    expect(apiKey.key.startsWith("fgw_")).toBe(true);
    expect(apiKey.key).toHaveLength(68); // 4 prefix + 64 hex
  });

  it("create key → key hash stored, not plaintext", () => {
    const apiKey = store.create("test-key", ["admin"]);
    // Verify hash is stored
    const row = db
      .query("SELECT key_hash, key_display FROM api_keys WHERE id = ?")
      .get(apiKey.id) as { key_hash: string; key_display: string } | null;
    expect(row).not.toBeNull();
    expect(row!.key_hash).toBe(hashKey(apiKey.key));
    // Plaintext key should NOT appear in the DB
    const allRows = db
      .query("SELECT key_hash, key_display FROM api_keys")
      .all() as Array<{ key_hash: string; key_display: string }>;
    for (const r of allRows) {
      expect(r.key_hash).not.toBe(apiKey.key);
      expect(r.key_display).not.toBe(apiKey.key);
    }
  });

  it("create key → defaults to admin scope when empty", () => {
    const apiKey = store.create("test-key", []);
    expect(apiKey.scopes).toEqual(["admin"]);
  });

  it("create key with expiry → expires_at stored", () => {
    const future = new Date(Date.now() + 86_400_000);
    const apiKey = store.create("with-expiry", ["read_only"], future);
    expect(apiKey.expiresAt).not.toBeNull();
    expect(apiKey.expiresAt!.getTime()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // ValidateKey
  // -------------------------------------------------------------------------

  it("validateKey with correct key → returns APIKey", () => {
    const created = store.create("valid-key", ["admin"]);
    const validated = store.validateKey(created.key);
    expect(validated).not.toBeNull();
    expect(validated!.id).toBe(created.id);
  });

  it("validateKey with wrong key → returns null", () => {
    store.create("valid-key", ["admin"]);
    const validated = store.validateKey("fgw_0000000000000000deadbeef");
    expect(validated).toBeNull();
  });

  it("validateKey with revoked key → returns null", () => {
    const created = store.create("rev-key", ["admin"]);
    store.revoke(created.id);
    const validated = store.validateKey(created.key);
    expect(validated).toBeNull();
  });

  it("validateKey with expired key → returns null", () => {
    const past = new Date(Date.now() - 86_400_000);
    const created = store.create("exp-key", ["admin"], past);
    const validated = store.validateKey(created.key);
    expect(validated).toBeNull();
  });

  it("validateKey with empty string → returns null", () => {
    expect(store.validateKey("")).toBeNull();
  });

  it("validateKey increments usage_count", () => {
    const created = store.create("usage-key", ["admin"]);
    const before = store.get(created.id)!;
    expect(before.usageCount).toBe(0);

    store.validateKey(created.key);
    const after = store.get(created.id)!;
    expect(after.usageCount).toBe(1);
    expect(after.lastUsedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------

  it("get by ID → returns key", () => {
    const created = store.create("get-key", ["admin"]);
    const fetched = store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("get-key");
  });

  it("get by non-existent ID → returns null", () => {
    expect(store.get("does-not-exist")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  it("list → returns all keys", () => {
    store.create("key-a", ["admin"]);
    store.create("key-b", ["read_only"]);
    const keys = store.list();
    expect(keys).toHaveLength(2);
    const names = new Set(keys.map((k) => k.name));
    expect(names.has("key-a")).toBe(true);
    expect(names.has("key-b")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // IsEmpty
  // -------------------------------------------------------------------------

  it("isEmpty on fresh DB → true", () => {
    expect(store.isEmpty()).toBe(true);
  });

  it("isEmpty after create → false", () => {
    store.create("not-empty", ["admin"]);
    expect(store.isEmpty()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  it("revoke key → active=false, revokedAt set", () => {
    const created = store.create("rev-key", ["admin"]);
    store.revoke(created.id);
    const revoked = store.get(created.id);
    expect(revoked!.active).toBe(false);
    expect(revoked!.revokedAt).not.toBeNull();
  });

  it("revoke non-existent key → throws KeyNotFoundError", () => {
    expect(() => store.revoke("no-such-id")).toThrow(KeyNotFoundError);
  });

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  it("update key name and scopes", () => {
    const created = store.create("original", ["admin"]);
    const updated = store.update(created.id, "renamed", ["read_only"]);
    expect(updated.name).toBe("renamed");
    expect(updated.scopes).toEqual(["read_only"]);

    // Verify persisted
    const fetched = store.get(created.id);
    expect(fetched!.name).toBe("renamed");
    expect(fetched!.scopes).toEqual(["read_only"]);
  });

  it("update with empty name → keeps current name", () => {
    const created = store.create("keep-name", ["admin"]);
    const updated = store.update(created.id, "", ["read_only"]);
    expect(updated.name).toBe("keep-name");
    expect(updated.scopes).toEqual(["read_only"]);
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  it("delete key → gone from list", () => {
    const created = store.create("del-key", ["admin"]);
    store.delete(created.id);
    expect(store.get(created.id)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it("delete non-existent key → throws KeyNotFoundError", () => {
    expect(() => store.delete("no-such-id")).toThrow(KeyNotFoundError);
  });

  // -------------------------------------------------------------------------
  // RotateKey
  // -------------------------------------------------------------------------

  it("rotate key → new key works, old key invalid", () => {
    const created = store.create("rotate-key", ["admin"]);
    const originalKey = created.key;

    const rotated = store.rotateKey(created.id);
    expect(rotated.key).not.toBe(originalKey);
    expect(rotated.key.startsWith("fgw_")).toBe(true);
    expect(rotated.rotatedAt).not.toBeNull();

    // Old key should no longer validate
    expect(store.validateKey(originalKey)).toBeNull();

    // New key should validate
    const validated = store.validateKey(rotated.key);
    expect(validated).not.toBeNull();
    expect(validated!.id).toBe(created.id);
  });

  it("rotate non-existent key → throws KeyNotFoundError", () => {
    expect(() => store.rotateKey("no-such-id")).toThrow(KeyNotFoundError);
  });

  // -------------------------------------------------------------------------
  // SetExpiration
  // -------------------------------------------------------------------------

  it("setExpiration → expires_at updated", () => {
    const created = store.create("exp-key", ["admin"]);
    expect(created.expiresAt).toBeNull();

    const future = new Date(Date.now() + 172_800_000);
    store.setExpiration(created.id, future);

    const fetched = store.get(created.id);
    expect(fetched!.expiresAt).not.toBeNull();
  });

  it("setExpiration(null) → clears expires_at", () => {
    const future = new Date(Date.now() + 172_800_000);
    const created = store.create("exp-key", ["admin"], future);
    expect(created.expiresAt).not.toBeNull();

    store.setExpiration(created.id, null);
    const fetched = store.get(created.id);
    expect(fetched!.expiresAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Ping
  // -------------------------------------------------------------------------

  it("ping → succeeds on open DB", () => {
    expect(() => store.ping()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Migration idempotency
  // -------------------------------------------------------------------------

  it("re-open store → migrations idempotent (no re-run)", async () => {
    const tmpPath = `/tmp/key-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const tmpDb = new Database(tmpPath);
    const store1 = await KeyStore.create(tmpDb);
    store1.create("persistent", ["admin"]);
    store1.close();
    tmpDb.close();

    const tmpDb2 = new Database(tmpPath);
    const store2 = await KeyStore.create(tmpDb2);
    const keys = store2.list();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.name).toBe("persistent");
    store2.close();
    tmpDb2.close();

    const unlinkSync = require("fs").unlinkSync;
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  });
});
