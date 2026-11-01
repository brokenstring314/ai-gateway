/**
 * Runtime configuration store (0.3.0, plan §3.1/§3.3/§9.2).
 *
 * The runtime resources — channels (upstream targets) and their keys,
 * published models and bindings, routing settings (strategy, aliases,
 * plugins, compatibility) — live in SQLite instead of the YAML file, so the
 * Admin API / console can change them without a restart. Startup-only
 * settings (server, auth, CORS, observability, MCP, …) stay in YAML.
 *
 * Every change is one transaction: write the resources, write a config
 * version (full JSON snapshot, key ciphertext only), write an audit row.
 *
 * Upstream keys never enter the database in plaintext:
 *  - a literal key is stored as an AES-256-GCM envelope (SecretBox), bound to
 *    its channel id (moving it to another row fails to decrypt);
 *  - a pure environment reference ("${DEEPSEEK_API_KEY}") is stored as that
 *    reference and resolved from the environment at use, as in 0.2.0.
 * Lists and snapshots carry only a masked hint ("sk-…abcd").
 */

import type { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database as SqliteDatabase } from "bun:sqlite";
import type { GatewayConfig, ModelBindingConfig, PublishedModelConfig, TargetConfig } from "../config/types.js";
import { stableKey } from "../config/stable-key.js";
import { maskSecret, type SecretBox, SECRET_KEY_HELP } from "../secrets/secret-box.js";
import { type MigrationStep, runMigrations } from "./migrations.js";

const LEDGER = "config_schema_migrations";

/** Top-level config sections that live in the store (everything else is startup config). */
export const RUNTIME_SECTIONS = ["targets", "models", "strategy", "aliases", "plugins", "compatibility"] as const;
type SettingKey = "strategy" | "aliases" | "plugins" | "compatibility";
const SETTING_KEYS: readonly SettingKey[] = ["strategy", "aliases", "plugins", "compatibility"];

const ENV_REF_ONLY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export class ConfigStoreError extends Error {
  override name = "ConfigStoreError";
}

export function configStorePath(dataDir: string): string {
  return join(dataDir, "config.sqlite");
}

function steps(): MigrationStep[] {
  return [
    {
      version: 1,
      name: "runtime_config_baseline",
      sql: `
CREATE TABLE channels (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  preset        TEXT NOT NULL,
  base_url      TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority      INTEGER NOT NULL DEFAULT 0,
  models_json   TEXT NOT NULL DEFAULT '[]',
  settings_json TEXT NOT NULL DEFAULT '{}',
  revision      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE channel_keys (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('encrypted', 'env_ref')),
  value       TEXT NOT NULL,
  hint        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'invalid', 'quota')),
  last_error  TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX channel_keys_channel ON channel_keys(channel_id, position);
CREATE TABLE models (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  description   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  pricing_json  TEXT NOT NULL DEFAULT '{}',
  routing_json  TEXT NOT NULL DEFAULT '{}',
  revision      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE model_bindings (
  id             TEXT PRIMARY KEY,
  model_id       TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  upstream_model TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 0,
  weight         REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  overrides_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (model_id, channel_id, upstream_model)
);
CREATE INDEX model_bindings_channel ON model_bindings(channel_id);
CREATE TABLE runtime_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE config_versions (
  version       INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL,
  actor         TEXT,
  summary       TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor         TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  detail_json   TEXT
);
CREATE INDEX audit_log_at ON audit_log(at);
CREATE TABLE config_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`,
    },
  ];
}

/** Open (or create) the config database: WAL, busy timeout, foreign keys on. */
export function openConfigDatabase(path: string): Database {
  const fresh = path !== ":memory:" && !existsSync(path);
  const db = new SqliteDatabase(path, { create: true, readwrite: true });
  // Owner-only: it holds key ciphertexts and the whole routing config.
  // SQLite gives the -wal/-shm files the database file's mode.
  if (fresh) chmodSync(path, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Another connection holds it in rollback mode; keep that.
  }
  return db;
}

/**
 * Copy an existing database aside before migrating it (plan §9.2): a failed
 * or buggy migration can always be undone by restoring the copy.
 */
function backupBeforeMigration(db: Database, path: string, known: readonly MigrationStep[]): string | undefined {
  if (path === ":memory:" || !existsSync(path)) return undefined;
  const hasLedger = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(LEDGER);
  if (!hasLedger) return undefined;
  const applied = new Set(
    (db.query(`SELECT version FROM ${LEDGER}`).all() as Array<{ version: number }>).map((r) => r.version),
  );
  if (known.every((s) => applied.has(s.version))) return undefined;
  const target = `${path}.pre-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  try {
    db.query("VACUUM INTO ?").run(target);
  } catch {
    copyFileSync(path, target);
  }
  chmodSync(target, 0o600);
  return target;
}

export interface ChannelKeyView {
  readonly id: string;
  readonly kind: "encrypted" | "env_ref";
  readonly hint: string;
  readonly enabled: boolean;
  readonly status: "ok" | "invalid" | "quota";
}

export interface ChannelView {
  readonly id: string;
  readonly name: string;
  readonly preset: string;
  readonly baseURL?: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly models: readonly string[];
  readonly settings: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly keys: readonly ChannelKeyView[];
}

export interface ConfigVersionInfo {
  readonly version: number;
  readonly createdAt: string;
  readonly actor: string | null;
  readonly summary: string;
}

interface ChannelRow {
  id: string;
  name: string;
  preset: string;
  base_url: string | null;
  enabled: number;
  priority: number;
  models_json: string;
  settings_json: string;
  revision: number;
}

interface KeyRow {
  id: string;
  channel_id: string;
  kind: "encrypted" | "env_ref";
  value: string;
  hint: string;
  enabled: number;
  status: "ok" | "invalid" | "quota";
}

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function keyContext(channelId: string): string {
  return `channel_key:${channelId}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash of a config's runtime sections, to tell whether the YAML changed since it was imported. */
export async function runtimeSectionsHash(config: GatewayConfig): Promise<string> {
  const sections: Record<string, unknown> = {};
  for (const key of RUNTIME_SECTIONS) sections[key] = (config as unknown as Record<string, unknown>)[key] ?? null;
  return sha256Hex(stableKey(sections));
}

/** A target as stored: everything but the columns of its own. */
function splitTarget(target: TargetConfig): { settings: Record<string, unknown> } {
  const { name: _n, provider: _p, apiKey: _k, baseURL: _b, models: _m, ...settings } = target;
  return { settings };
}

export class ConfigStore {
  private constructor(
    private readonly db: Database,
    private readonly box: SecretBox | undefined,
  ) {}

  /**
   * Open the store on `db`: back up an existing database that has pending
   * migrations, then migrate. A migration failure throws (the gateway must
   * not start on a half-migrated store). `box` encrypts literal upstream
   * keys; without it only env references can be stored or read.
   */
  static async create(db: Database, box: SecretBox | undefined, path = ":memory:"): Promise<ConfigStore> {
    db.exec("PRAGMA foreign_keys = ON");
    const known = steps();
    const backup = backupBeforeMigration(db, path, known);
    if (backup) console.log(`[config-store] backed up ${path} to ${backup} before migrating`);
    await runMigrations(db, known, { ledger: LEDGER });
    return new ConfigStore(db, box);
  }

  close(): void {
    this.db.close();
  }

  /** Whether runtime config has been imported/created (any channel or settings row). */
  isInitialized(): boolean {
    return this.db.query("SELECT value FROM config_meta WHERE key = 'initialized_at'").get() !== null;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM config_meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value;
  }

  // ── Import ──

  /**
   * Replace every runtime resource with `config`'s runtime sections, in one
   * transaction, recorded as a new config version and an audit entry.
   * Encrypts literal upstream keys first; throws (writing nothing) when one
   * needs encrypting and no GATEWAY_SECRET_KEY is configured.
   */
  async importFromConfig(
    config: GatewayConfig,
    opts: { actor?: string; summary?: string } = {},
  ): Promise<ConfigVersionInfo> {
    const now = new Date().toISOString();
    // Prepare outside the transaction (WebCrypto is async; bun:sqlite transactions are sync).
    const channels = await Promise.all(
      config.targets.map(async (target, index) => {
        const id = newId("ch");
        const keys: KeyRow[] = [];
        const apiKey = target.apiKey ?? "";
        if (apiKey !== "") {
          const keyId = newId("chk");
          if (ENV_REF_ONLY.test(apiKey)) {
            keys.push({
              id: keyId,
              channel_id: id,
              kind: "env_ref",
              value: apiKey,
              hint: apiKey,
              enabled: 1,
              status: "ok",
            });
          } else {
            if (!this.box) {
              throw new ConfigStoreError(
                `target "${target.name}" has a literal apiKey, and storing it requires GATEWAY_SECRET_KEY ` +
                  `(upstream keys are encrypted at rest). ${SECRET_KEY_HELP} ` +
                  'Alternatively reference it from the environment (apiKey: "${MY_KEY}") or set runtimeConfig.source: file.',
              );
            }
            const value = await this.box.encrypt(apiKey, keyContext(id));
            keys.push({
              id: keyId,
              channel_id: id,
              kind: "encrypted",
              value,
              hint: maskSecret(apiKey),
              enabled: 1,
              status: "ok",
            });
          }
        }
        return { id, index, target, keys };
      }),
    );
    const yamlHash = await runtimeSectionsHash(config);

    const write = this.db.transaction(() => {
      this.db.exec(
        "DELETE FROM model_bindings; DELETE FROM models; DELETE FROM channel_keys; DELETE FROM channels; DELETE FROM runtime_settings;",
      );
      const insChannel = this.db.prepare(
        `INSERT INTO channels (id, name, preset, base_url, enabled, priority, models_json, settings_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`,
      );
      const insKey = this.db.prepare(
        `INSERT INTO channel_keys (id, channel_id, kind, value, hint, enabled, status, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'ok', ?, ?, ?)`,
      );
      for (const { id, index, target, keys } of channels) {
        insChannel.run(
          id,
          target.name,
          target.provider,
          target.baseURL ?? null,
          index,
          JSON.stringify(target.models ?? []),
          JSON.stringify(splitTarget(target).settings),
          now,
          now,
        );
        keys.forEach((k, pos) => {
          insKey.run(k.id, id, k.kind, k.value, k.hint, pos, now, now);
        });
      }
      const channelIdByName = new Map(channels.map((c) => [c.target.name, c.id]));
      const insModel = this.db.prepare(
        `INSERT INTO models (id, name, display_name, description, enabled, metadata_json, pricing_json, routing_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?)`,
      );
      const insBinding = this.db.prepare(
        `INSERT INTO model_bindings (id, model_id, channel_id, upstream_model, priority, weight, enabled, overrides_json)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      );
      for (const m of config.models ?? []) {
        const modelId = newId("mdl");
        insModel.run(
          modelId,
          m.name,
          m.displayName ?? null,
          m.description ?? null,
          m.enabled === false ? 0 : 1,
          JSON.stringify(m.metadata ?? {}),
          JSON.stringify({ strategy: m.strategy ?? "fallback" }),
          now,
          now,
        );
        m.bindings.forEach((b, i) => {
          const channelId = channelIdByName.get(b.target);
          if (channelId === undefined)
            throw new ConfigStoreError(`model "${m.name}" binds unknown target "${b.target}"`);
          insBinding.run(
            newId("bnd"),
            modelId,
            channelId,
            b.model ?? m.name,
            b.priority ?? i,
            b.weight ?? 1,
            JSON.stringify(b.params ?? {}),
          );
        });
      }
      const insSetting = this.db.prepare(
        "INSERT INTO runtime_settings (key, value_json, revision, updated_at) VALUES (?, ?, 1, ?)",
      );
      for (const key of SETTING_KEYS) {
        const value = (config as unknown as Record<string, unknown>)[key];
        if (value !== undefined) insSetting.run(key, JSON.stringify(value), now);
      }
      const setMeta = this.db.prepare("INSERT OR REPLACE INTO config_meta (key, value) VALUES (?, ?)");
      setMeta.run("yaml_runtime_hash", yamlHash);
      // Explicit published models (models: section) vs derived from targets[].models.
      setMeta.run("models_explicit", config.models !== undefined ? "1" : "0");
      setMeta.run("yaml_imported_at", now);
      if (!this.isInitialized()) setMeta.run("initialized_at", now);
      const summary = opts.summary ?? `Imported ${channels.length} target(s) and routing settings from config file`;
      const info = this.recordVersion(summary, opts.actor ?? "system:import", now);
      this.audit(opts.actor ?? "system:import", "import", "runtime_config", null, { channels: channels.length }, now);
      return info;
    });
    return write();
  }

  // ── Read ──

  listChannels(): ChannelView[] {
    const keys = this.db
      .query(
        "SELECT id, channel_id, kind, value, hint, enabled, status FROM channel_keys ORDER BY position, created_at",
      )
      .all() as KeyRow[];
    const byChannel = new Map<string, KeyRow[]>();
    for (const k of keys) byChannel.set(k.channel_id, [...(byChannel.get(k.channel_id) ?? []), k]);
    const rows = this.db
      .query(
        "SELECT id, name, preset, base_url, enabled, priority, models_json, settings_json, revision FROM channels ORDER BY priority, name",
      )
      .all() as ChannelRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      preset: r.preset,
      ...(r.base_url !== null ? { baseURL: r.base_url } : {}),
      enabled: r.enabled === 1,
      priority: r.priority,
      models: JSON.parse(r.models_json) as string[],
      settings: JSON.parse(r.settings_json) as Record<string, unknown>,
      revision: r.revision,
      // Never the value: only what identifies the key.
      keys: (byChannel.get(r.id) ?? []).map((k) => ({
        id: k.id,
        kind: k.kind,
        hint: k.hint,
        enabled: k.enabled === 1,
        status: k.status,
      })),
    }));
  }

  listVersions(limit = 50): ConfigVersionInfo[] {
    const rows = this.db
      .query("SELECT version, created_at, actor, summary FROM config_versions ORDER BY version DESC LIMIT ?")
      .all(limit) as Array<{ version: number; created_at: string; actor: string | null; summary: string }>;
    return rows.map((r) => ({ version: r.version, createdAt: r.created_at, actor: r.actor, summary: r.summary }));
  }

  listAudit(limit = 100): Array<{
    id: number;
    at: string;
    actor: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    detail: unknown;
  }> {
    const rows = this.db
      .query(
        "SELECT id, at, actor, action, resource_type, resource_id, detail_json FROM audit_log ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as Array<{
      id: number;
      at: string;
      actor: string | null;
      action: string;
      resource_type: string;
      resource_id: string | null;
      detail_json: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      detail: r.detail_json === null ? null : JSON.parse(r.detail_json),
    }));
  }

  /**
   * The runtime sections as a config fragment (targets with their first
   * usable key decrypted, in memory only). Throws ConfigStoreError when an
   * encrypted key cannot be decrypted (missing or wrong GATEWAY_SECRET_KEY).
   */
  async loadRuntimeSections(): Promise<Pick<GatewayConfig, "targets" | "strategy"> & Partial<GatewayConfig>> {
    const channels = this.db
      .query(
        "SELECT id, name, preset, base_url, enabled, priority, models_json, settings_json, revision FROM channels WHERE enabled = 1 ORDER BY priority, name",
      )
      .all() as ChannelRow[];
    const targets: TargetConfig[] = [];
    for (const ch of channels) {
      const key = this.db
        .query(
          "SELECT id, channel_id, kind, value, hint, enabled, status FROM channel_keys WHERE channel_id = ? AND enabled = 1 ORDER BY (status = 'ok') DESC, position, created_at LIMIT 1",
        )
        .get(ch.id) as KeyRow | null;
      let apiKey = "";
      if (key?.kind === "env_ref") apiKey = key.value;
      else if (key?.kind === "encrypted") {
        if (!this.box) {
          throw new ConfigStoreError(
            `channel "${ch.name}" has an encrypted upstream key and GATEWAY_SECRET_KEY is not set. ${SECRET_KEY_HELP}`,
          );
        }
        try {
          apiKey = await this.box.decrypt(key.value, keyContext(ch.id));
        } catch (err) {
          throw new ConfigStoreError(
            `cannot decrypt the upstream key of channel "${ch.name}": ${err instanceof Error ? err.message : String(err)}. ` +
              "Is GATEWAY_SECRET_KEY the key it was stored with?",
          );
        }
      }
      const models = JSON.parse(ch.models_json) as string[];
      targets.push({
        ...(JSON.parse(ch.settings_json) as Partial<TargetConfig>),
        name: ch.name,
        provider: ch.preset,
        apiKey,
        ...(ch.base_url !== null ? { baseURL: ch.base_url } : {}),
        ...(models.length > 0 ? { models } : {}),
      });
    }
    const settings = new Map(
      (
        this.db.query("SELECT key, value_json FROM runtime_settings").all() as Array<{
          key: string;
          value_json: string;
        }>
      ).map((r) => [r.key, JSON.parse(r.value_json) as unknown]),
    );
    const out: Record<string, unknown> = { targets };
    for (const key of SETTING_KEYS) if (settings.has(key)) out[key] = settings.get(key);
    if (this.getMeta("models_explicit") === "1") out["models"] = this.loadModels();
    if (!out["strategy"]) throw new ConfigStoreError("runtime config store has no routing strategy");
    return out as Pick<GatewayConfig, "targets" | "strategy"> & Partial<GatewayConfig>;
  }

  /** Published models with their enabled bindings (to enabled channels), in config shape. */
  private loadModels(): PublishedModelConfig[] {
    const models = this.db
      .query(
        "SELECT id, name, display_name, description, enabled, metadata_json, routing_json FROM models ORDER BY created_at, rowid",
      )
      .all() as Array<{
      id: string;
      name: string;
      display_name: string | null;
      description: string | null;
      enabled: number;
      metadata_json: string;
      routing_json: string;
    }>;
    const bindings = this.db
      .query(
        `SELECT b.model_id, c.name AS target, b.upstream_model, b.priority, b.weight, b.overrides_json
         FROM model_bindings b JOIN channels c ON c.id = b.channel_id
         WHERE b.enabled = 1 AND c.enabled = 1
         ORDER BY b.priority, b.rowid`,
      )
      .all() as Array<{
      model_id: string;
      target: string;
      upstream_model: string;
      priority: number;
      weight: number;
      overrides_json: string;
    }>;
    const out: PublishedModelConfig[] = [];
    for (const m of models) {
      const own = bindings.filter((b) => b.model_id === m.id);
      // A model whose every binding is gone (disabled channel) cannot be served: publish it disabled.
      const list: ModelBindingConfig[] = own.map((b, i) => {
        const params = JSON.parse(b.overrides_json) as Record<string, unknown>;
        return {
          target: b.target,
          ...(b.upstream_model !== m.name ? { model: b.upstream_model } : {}),
          ...(b.priority !== i ? { priority: b.priority } : {}),
          ...(b.weight !== 1 ? { weight: b.weight } : {}),
          ...(Object.keys(params).length > 0 ? { params } : {}),
        };
      });
      const metadata = JSON.parse(m.metadata_json) as Record<string, unknown>;
      const routing = JSON.parse(m.routing_json) as { strategy?: "fallback" | "loadbalance" };
      if (list.length === 0) continue;
      out.push({
        name: m.name,
        ...(m.enabled === 1 ? {} : { enabled: false }),
        ...(m.display_name !== null ? { displayName: m.display_name } : {}),
        ...(m.description !== null ? { description: m.description } : {}),
        ...(routing.strategy === "loadbalance" ? { strategy: "loadbalance" as const } : {}),
        bindings: list,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    }
    return out;
  }

  // ── Internals ──

  /** Snapshot of every runtime row (key ciphertext/env refs only; never plaintext). */
  private snapshotJson(): string {
    const channels = this.db.query("SELECT * FROM channels ORDER BY priority, name").all();
    const keys = this.db
      .query("SELECT id, channel_id, kind, value, hint, enabled, status, position FROM channel_keys")
      .all();
    const models = this.db.query("SELECT * FROM models ORDER BY name").all();
    const bindings = this.db.query("SELECT * FROM model_bindings").all();
    const settings = this.db.query("SELECT key, value_json FROM runtime_settings ORDER BY key").all();
    return JSON.stringify({ format: 1, channels, keys, models, bindings, settings });
  }

  private recordVersion(summary: string, actor: string, at: string): ConfigVersionInfo {
    const row = this.db
      .query(
        "INSERT INTO config_versions (created_at, actor, summary, snapshot_json) VALUES (?, ?, ?, ?) RETURNING version",
      )
      .get(at, actor, summary, this.snapshotJson()) as { version: number };
    return { version: row.version, createdAt: at, actor, summary };
  }

  private audit(
    actor: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    detail: unknown,
    at: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (at, actor, action, resource_type, resource_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(at, actor, action, resourceType, resourceId, detail === undefined ? null : JSON.stringify(detail));
  }
}
