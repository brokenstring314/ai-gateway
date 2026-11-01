import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFromObject } from "../../../src/config/loader.js";
import { composeConfig } from "../../../src/config/runtime-source.js";
import {
  ConfigStore,
  ConfigStoreError,
  configStorePath,
  openConfigDatabase,
} from "../../../src/persistence/config-store.js";
import { SecretBox } from "../../../src/secrets/secret-box.js";

const SECRET_A = "sk-literal-upstream-secret-AAAA1111";
const SECRET_B = "sk-literal-upstream-secret-BBBB2222";

function fileConfig(extra: Record<string, unknown> = {}) {
  return loadConfigFromObject({
    strategy: { mode: "fallback", targets: ["a", "b", "c"] },
    targets: [
      {
        name: "a",
        provider: "openai",
        apiKey: SECRET_A,
        baseURL: "https://a.example/v1",
        models: ["m1", "m2"],
        retry: { attempts: 2 },
        circuitBreaker: { failureThreshold: 3 },
        costPer1kInputTokens: 0.1,
      },
      { name: "b", provider: "deepseek", apiKey: SECRET_B, concurrency: { maxConcurrency: 4 } },
      { name: "c", provider: "openai", apiKey: "${UPSTREAM_C_KEY}", baseURL: "https://c.example/v1", weight: 2 },
    ],
    aliases: { fast: "m1" },
    plugins: [{ name: "rate-limit", stage: "before_request", config: { maxRequestsPerMinute: 10 } }],
    compatibility: { onUnsupportedParam: "drop" },
    server: { port: 4321 },
    requestTimeout: "30s",
    ...extra,
  });
}

const box = () => SecretBox.create(new Uint8Array(32).fill(7));
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cfgstore-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ConfigStore import / load", () => {
  it("round-trips the runtime sections exactly (compose(file, stored) == file)", async () => {
    const file = fileConfig();
    const store = await ConfigStore.create(new Database(":memory:"), await box());
    expect(store.isInitialized()).toBe(false);
    const v = await store.importFromConfig(file);
    expect(v.version).toBe(1);
    expect(store.isInitialized()).toBe(true);
    const composed = composeConfig(file, await store.loadRuntimeSections());
    expect(composed).toEqual(file);
  });

  it("lists channels with key hints only, env refs as references", async () => {
    const store = await ConfigStore.create(new Database(":memory:"), await box());
    await store.importFromConfig(fileConfig());
    const channels = store.listChannels();
    expect(channels.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(channels[0]?.keys[0]).toMatchObject({ kind: "encrypted", hint: "sk-…1111", status: "ok" });
    expect(channels[2]?.keys[0]).toMatchObject({ kind: "env_ref", hint: "${UPSTREAM_C_KEY}" });
    expect(JSON.stringify(channels)).not.toContain(SECRET_A);
  });

  it("never writes a plaintext upstream key to the database file (rows, versions, audit, WAL)", async () => {
    const dir = tempDir();
    const path = configStorePath(dir);
    const db = openConfigDatabase(path);
    const store = await ConfigStore.create(db, await box(), path);
    await store.importFromConfig(fileConfig());
    await store.importFromConfig(fileConfig(), { summary: "again" });
    for (const f of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, f)).toString("latin1");
      expect(bytes).not.toContain(SECRET_A);
      expect(bytes).not.toContain(SECRET_B);
    }
    const snap = db.query("SELECT snapshot_json FROM config_versions").all() as Array<{ snapshot_json: string }>;
    expect(snap.length).toBe(2);
    for (const s of snap) expect(s.snapshot_json).not.toContain(SECRET_A);
    store.close();
  });

  it("records a version and an audit entry per import", async () => {
    const store = await ConfigStore.create(new Database(":memory:"), await box());
    await store.importFromConfig(fileConfig());
    await store.importFromConfig(fileConfig(), { actor: "cli:test", summary: "re-import" });
    expect(store.listVersions().map((v) => v.version)).toEqual([2, 1]);
    expect(store.listVersions()[0]).toMatchObject({ actor: "cli:test", summary: "re-import" });
    expect(store.listAudit().map((a) => a.action)).toEqual(["import", "import"]);
  });

  it("refuses to store a literal key without GATEWAY_SECRET_KEY and writes nothing", async () => {
    const store = await ConfigStore.create(new Database(":memory:"), undefined);
    await expect(store.importFromConfig(fileConfig())).rejects.toBeInstanceOf(ConfigStoreError);
    expect(store.isInitialized()).toBe(false);
    expect(store.listChannels()).toEqual([]);
  });

  it("stores env-reference-only configs without a master key", async () => {
    const file = loadConfigFromObject({
      strategy: { mode: "single", targets: ["c"] },
      targets: [{ name: "c", provider: "openai", apiKey: "${UPSTREAM_C_KEY}", baseURL: "https://c.example/v1" }],
    });
    const store = await ConfigStore.create(new Database(":memory:"), undefined);
    await store.importFromConfig(file);
    expect(composeConfig(file, await store.loadRuntimeSections())).toEqual(file);
  });

  it("fails loudly when the master key is wrong or missing", async () => {
    const db = new Database(":memory:");
    const store = await ConfigStore.create(db, await box());
    await store.importFromConfig(fileConfig());
    const wrong = await ConfigStore.create(db, await SecretBox.create(new Uint8Array(32).fill(9)));
    await expect(wrong.loadRuntimeSections()).rejects.toThrow(/cannot decrypt the upstream key of channel "a"/);
    const none = await ConfigStore.create(db, undefined);
    await expect(none.loadRuntimeSections()).rejects.toThrow(/GATEWAY_SECRET_KEY is not set/);
  });

  it("detects a ciphertext moved to another channel (AAD binding)", async () => {
    const db = new Database(":memory:");
    const store = await ConfigStore.create(db, await box());
    await store.importFromConfig(fileConfig());
    const [a, b] = store.listChannels();
    db.query(
      "UPDATE channel_keys SET value = (SELECT value FROM channel_keys WHERE channel_id = ?) WHERE channel_id = ?",
    ).run(a!.id, b!.id);
    await expect(store.loadRuntimeSections()).rejects.toThrow(/channel "b"/);
  });

  it("enforces foreign keys: a channel with a model binding cannot be deleted", async () => {
    const db = new Database(":memory:");
    const store = await ConfigStore.create(db, await box());
    await store.importFromConfig(fileConfig());
    const ch = store.listChannels()[0]!;
    const now = new Date().toISOString();
    db.query("INSERT INTO models (id, name, created_at, updated_at) VALUES ('m_1', 'pub', ?, ?)").run(now, now);
    db.query(
      "INSERT INTO model_bindings (id, model_id, channel_id, upstream_model) VALUES ('b_1', 'm_1', ?, 'm1')",
    ).run(ch.id);
    expect(() => db.query("DELETE FROM channels WHERE id = ?").run(ch.id)).toThrow(/FOREIGN KEY/);
  });

  it("backs up an existing database before applying pending migrations", async () => {
    const dir = tempDir();
    const path = configStorePath(dir);
    // A database from an older build: ledger present, step 1 not applied yet.
    const old = new Database(path, { create: true });
    old.exec(
      "CREATE TABLE config_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    old.close();
    const store = await ConfigStore.create(openConfigDatabase(path), await box(), path);
    store.close();
    expect(readdirSync(dir).some((f) => f.includes(".pre-migration-") && f.endsWith(".bak"))).toBe(true);
    // Up to date: no further backups.
    const again = await ConfigStore.create(openConfigDatabase(path), await box(), path);
    again.close();
    expect(readdirSync(dir).filter((f) => f.endsWith(".bak")).length).toBe(1);
    expect(existsSync(path)).toBe(true);
  });
});
