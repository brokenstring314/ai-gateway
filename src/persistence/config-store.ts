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
import { chmodSync, copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Database as SqliteDatabase } from "bun:sqlite";
import type {
  GatewayConfig,
  ModelBindingConfig,
  PublishedModelConfig,
  TargetConfig,
  TargetKeyConfig,
} from "../config/types.js";
import { targetKeyEntries } from "../core/provider-presets.js";
import { stableKey } from "../config/stable-key.js";
import { maskSecret, type SecretBox, SECRET_KEY_HELP } from "../secrets/secret-box.js";
import { type MigrationStep, runMigrations } from "./migrations.js";

const LEDGER = "config_schema_migrations";

/** Top-level config sections that live in the store (everything else is startup config). */
export const RUNTIME_SECTIONS = [
  "targets",
  "models",
  "strategy",
  "aliases",
  "plugins",
  "compatibility",
  "limits",
] as const;
export type SettingKey = "strategy" | "aliases" | "plugins" | "compatibility" | "limits";
const SETTING_KEYS: readonly SettingKey[] = ["strategy", "aliases", "plugins", "compatibility", "limits"];
/** Runtime sections added later: hashed only when set, so an older import's hash still matches. */
const HASH_WHEN_SET: ReadonlySet<string> = new Set(["limits"]);

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
    {
      // 0.3.0 P4: key weights/revisions/error time; who set a channel's base URL.
      version: 2,
      name: "admin_api_keys_and_url_policy",
      sql: `
ALTER TABLE channels ADD COLUMN url_policy TEXT NOT NULL DEFAULT 'trusted' CHECK (url_policy IN ('trusted', 'public'));
ALTER TABLE channel_keys ADD COLUMN weight REAL NOT NULL DEFAULT 1 CHECK (weight >= 0);
ALTER TABLE channel_keys ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channel_keys ADD COLUMN last_error_at TEXT;
CREATE INDEX audit_log_resource ON audit_log(resource_type, resource_id);`,
    },
    {
      // 0.3.0 P5: the gateway no longer prices requests: drop the (never used)
      // model pricing column and any cost rates stored in channel settings.
      version: 3,
      name: "remove_pricing",
      fn: (db) => {
        const cols = db.query("PRAGMA table_info(models)").all() as Array<{ name: string }>;
        if (cols.some((c) => c.name === "pricing_json")) db.exec("ALTER TABLE models DROP COLUMN pricing_json");
        const rows = db.query("SELECT id, settings_json FROM channels").all() as Array<{
          id: string;
          settings_json: string;
        }>;
        for (const r of rows) {
          const stripped = stripRemovedSettings(r.settings_json);
          if (stripped !== r.settings_json) {
            db.query("UPDATE channels SET settings_json = ? WHERE id = ?").run(stripped, r.id);
          }
        }
      },
    },
  ];
}

/** Channel settings removed in 0.3.0 (prices); dropped from stored rows and restored snapshots. */
const REMOVED_CHANNEL_SETTINGS = ["costPer1kInputTokens", "costPer1kOutputTokens"] as const;

/** `settings_json` without the removed settings (unchanged text when none is present). */
function stripRemovedSettings(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return json;
  const obj = parsed as Record<string, unknown>;
  if (!REMOVED_CHANNEL_SETTINGS.some((k) => k in obj)) return json;
  for (const k of REMOVED_CHANNEL_SETTINGS) delete obj[k];
  return JSON.stringify(obj);
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

// ── Views (never a key value: only what identifies a key) ──

export type KeyStatus = "ok" | "invalid" | "quota";

export interface ChannelKeyView {
  readonly id: string;
  readonly kind: "encrypted" | "env_ref";
  readonly hint: string;
  readonly enabled: boolean;
  readonly status: KeyStatus;
  readonly weight: number;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly revision: number;
}

export interface ChannelView {
  readonly id: string;
  readonly name: string;
  readonly preset: string;
  readonly baseURL?: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly models: readonly string[];
  /** Target settings: weight, retry, circuitBreaker, concurrency, keyStrategy, keyCooldownSeconds. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** "public": base URL written via the Admin API (public internet only); "trusted": from the config file. */
  readonly urlPolicy: "public" | "trusted";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly keys: readonly ChannelKeyView[];
}

export interface BindingView {
  readonly id: string;
  readonly channelId: string;
  readonly channel: string;
  readonly upstreamModel: string;
  readonly priority: number;
  readonly weight: number;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ModelView {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly strategy: "fallback" | "loadbalance";
  readonly balance: "weighted" | "round_robin" | "least_inflight";
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly bindings: readonly BindingView[];
}

export interface SettingsView {
  readonly strategy: unknown;
  readonly aliases: Readonly<Record<string, string>>;
  readonly plugins: readonly unknown[];
  readonly compatibility: unknown | null;
  /** Request limits for models without their own metadata ({} = defaults). */
  readonly limits: Readonly<Record<string, unknown>>;
  /** explicit: the models section is the published list; derived: targets[].models are published. */
  readonly modelSource: "explicit" | "derived";
  readonly revision: number;
}

export interface ConfigVersionInfo {
  readonly version: number;
  readonly createdAt: string;
  readonly actor: string | null;
  readonly summary: string;
}

export interface AuditEntry {
  readonly id: number;
  readonly at: string;
  readonly actor: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly detail: unknown;
}

/** A resource is missing (404). */
export class ConfigNotFoundError extends ConfigStoreError {
  override name = "ConfigNotFoundError";
}

/** The write conflicts with the stored state (409): revision mismatch, name taken, still referenced. */
export class ConfigConflictError extends ConfigStoreError {
  override name = "ConfigConflictError";
  constructor(
    message: string,
    readonly code: string,
    readonly currentRevision?: number,
  ) {
    super(message);
  }
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
  url_policy: "public" | "trusted";
  revision: number;
  created_at: string;
  updated_at: string;
}

interface KeyRow {
  id: string;
  channel_id: string;
  kind: "encrypted" | "env_ref";
  value: string;
  hint: string;
  enabled: number;
  status: KeyStatus;
  last_error: string | null;
  last_error_at: string | null;
  weight: number;
  position: number;
  revision: number;
}

interface ModelRow {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  enabled: number;
  metadata_json: string;
  routing_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  id: string;
  model_id: string;
  channel_id: string;
  channel: string;
  upstream_model: string;
  priority: number;
  weight: number;
  enabled: number;
  overrides_json: string;
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function keyContext(channelId: string): string {
  return `channel_key:${channelId}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash of a config's runtime sections, to tell whether the YAML changed since it was imported. */
export async function runtimeSectionsHash(config: GatewayConfig): Promise<string> {
  const sections: Record<string, unknown> = {};
  for (const key of RUNTIME_SECTIONS) {
    const value = (config as unknown as Record<string, unknown>)[key];
    if (value === undefined && HASH_WHEN_SET.has(key)) continue;
    sections[key] = value ?? null;
  }
  return sha256Hex(stableKey(sections));
}

/** Target fields that live in their own columns (everything else is settings_json). */
const TARGET_COLUMN_FIELDS = new Set([
  "name",
  "provider",
  "apiKey",
  "apiKeys",
  "baseURL",
  "models",
  "enabled",
  "publicNetworkOnly",
]);

function targetSettings(target: TargetConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(target)) if (!TARGET_COLUMN_FIELDS.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** A key to write: plaintext prepared (encrypted / env reference) outside the transaction. */
export interface PreparedKey {
  readonly id: string;
  readonly kind: "encrypted" | "env_ref";
  readonly value: string;
  readonly hint: string;
  readonly weight: number;
  readonly enabled: boolean;
  /** Plaintext for the in-memory key cache (encrypted keys only). */
  readonly plaintext?: string;
}

export interface MutationMeta {
  readonly actor: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly summary: string;
  /** Audit detail: what changed (field names, ids, hints), never a secret. */
  readonly detail?: unknown;
  /** Refuse (409) unless the latest config version is this one (whole-config writes: rollback). */
  readonly expectHead?: number;
}

/** The runtime sections of the config (input to composeConfig). */
export type RuntimeSections = Pick<GatewayConfig, "targets" | "strategy"> & Partial<GatewayConfig>;

const SNAPSHOT_FORMAT = 2;

export class ConfigStore {
  /** Decrypted upstream keys by key id (memory only): runtime builds need no async decryption. */
  private readonly keyCache = new Map<string, string>();
  private lastBackupAt = 0;

  private constructor(
    private readonly db: Database,
    private readonly box: SecretBox | undefined,
    readonly path: string,
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
    return new ConfigStore(db, box, path);
  }

  close(): void {
    this.db.close();
  }

  /** Whether literal upstream keys can be stored (GATEWAY_SECRET_KEY configured). */
  get canEncrypt(): boolean {
    return this.box !== undefined;
  }

  /** Whether runtime config has been imported/created (any channel or settings row). */
  isInitialized(): boolean {
    return this.db.query("SELECT value FROM config_meta WHERE key = 'initialized_at'").get() !== null;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM config_meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO config_meta (key, value) VALUES (?, ?)").run(key, value);
  }

  // ── Keys: encryption outside transactions, plaintext cache in memory ──

  /** Encrypt / classify a key for `channelId` (async: call before mutate). */
  async prepareKey(
    channelId: string,
    plaintext: string,
    opts: { weight?: number; enabled?: boolean; allowEnvRef?: boolean } = {},
  ): Promise<PreparedKey> {
    const id = newId("chk");
    const weight = opts.weight ?? 1;
    const enabled = opts.enabled !== false;
    if (ENV_REF_ONLY.test(plaintext)) {
      if (!opts.allowEnvRef) throw new ConfigStoreError("environment references are only allowed in the config file");
      return { id, kind: "env_ref", value: plaintext, hint: plaintext, weight, enabled };
    }
    if (!this.box) {
      throw new ConfigStoreError(
        `storing an upstream key requires GATEWAY_SECRET_KEY (upstream keys are encrypted at rest). ${SECRET_KEY_HELP}`,
      );
    }
    const value = await this.box.encrypt(plaintext, keyContext(channelId));
    return { id, kind: "encrypted", value, hint: maskSecret(plaintext), weight, enabled, plaintext };
  }

  /** Decrypt every stored key (or those of `rows`) not yet in the cache. */
  async warmKeys(rows?: ReadonlyArray<Pick<KeyRow, "id" | "channel_id" | "kind" | "value">>): Promise<void> {
    const list =
      rows ??
      (this.db.query("SELECT id, channel_id, kind, value FROM channel_keys").all() as Array<
        Pick<KeyRow, "id" | "channel_id" | "kind" | "value">
      >);
    const names = new Map(
      (this.db.query("SELECT id, name FROM channels").all() as Array<{ id: string; name: string }>).map((r) => [
        r.id,
        r.name,
      ]),
    );
    for (const k of list) {
      if (k.kind !== "encrypted" || this.keyCache.has(k.id)) continue;
      const channel = names.get(k.channel_id) ?? k.channel_id;
      if (!this.box) {
        throw new ConfigStoreError(
          `channel "${channel}" has an encrypted upstream key and GATEWAY_SECRET_KEY is not set. ${SECRET_KEY_HELP}`,
        );
      }
      try {
        this.keyCache.set(k.id, await this.box.decrypt(k.value, keyContext(k.channel_id)));
      } catch (err) {
        throw new ConfigStoreError(
          `cannot decrypt the upstream key of channel "${channel}": ${err instanceof Error ? err.message : String(err)}. ` +
            "Is GATEWAY_SECRET_KEY the key it was stored with?",
        );
      }
    }
  }

  /** The usable value of one stored key (env reference unexpanded), for channel tests. */
  async keyValue(keyId: string): Promise<{ channelId: string; kind: "encrypted" | "env_ref"; value: string }> {
    const row = this.db.query("SELECT id, channel_id, kind, value FROM channel_keys WHERE id = ?").get(keyId) as Pick<
      KeyRow,
      "id" | "channel_id" | "kind" | "value"
    > | null;
    if (!row) throw new ConfigNotFoundError(`key ${keyId} not found`);
    if (row.kind === "env_ref") return { channelId: row.channel_id, kind: row.kind, value: row.value };
    await this.warmKeys([row]);
    return { channelId: row.channel_id, kind: row.kind, value: this.keyCache.get(row.id) ?? "" };
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
    // Prepare outside the transaction (WebCrypto is async; bun:sqlite transactions are sync).
    const channels = await Promise.all(
      config.targets.map(async (target, index) => {
        const id = newId("ch");
        const keys: PreparedKey[] = [];
        for (const entry of targetKeyEntries(target)) {
          if (entry.raw === "") continue;
          try {
            keys.push(
              await this.prepareKey(id, entry.raw, { weight: entry.weight, enabled: entry.enabled, allowEnvRef: true }),
            );
          } catch (err) {
            if (!(err instanceof ConfigStoreError)) throw err;
            throw new ConfigStoreError(
              `target "${target.name}" has a literal upstream key, and storing it requires GATEWAY_SECRET_KEY ` +
                `(upstream keys are encrypted at rest). ${SECRET_KEY_HELP} ` +
                'Alternatively reference it from the environment (apiKey: "${MY_KEY}") or set runtimeConfig.source: file.',
            );
          }
        }
        return { id, index, target, keys };
      }),
    );
    const yamlHash = await runtimeSectionsHash(config);
    const actor = opts.actor ?? "system:import";
    const summary = opts.summary ?? `Imported ${channels.length} target(s) and routing settings from config file`;

    const write = this.db.transaction(() => {
      const now = new Date().toISOString();
      const version = this.reserveVersion(actor, summary, now);
      this.db.exec(
        "DELETE FROM model_bindings; DELETE FROM models; DELETE FROM channel_keys; DELETE FROM channels; DELETE FROM runtime_settings;",
      );
      for (const { id, index, target, keys } of channels) {
        this.insertChannelRow(
          {
            id,
            name: target.name,
            preset: target.provider,
            baseURL: target.baseURL ?? null,
            enabled: target.enabled !== false,
            priority: index,
            models: target.models ?? [],
            settings: targetSettings(target),
            urlPolicy: target.publicNetworkOnly === true ? "public" : "trusted",
          },
          version,
          now,
        );
        keys.forEach((k, pos) => {
          this.insertKeyRow(id, k, pos, version, now);
        });
      }
      const channelIdByName = new Map(channels.map((c) => [c.target.name, c.id]));
      for (const m of config.models ?? []) {
        const modelId = newId("mdl");
        this.insertModelRow(
          {
            id: modelId,
            name: m.name,
            displayName: m.displayName ?? null,
            description: m.description ?? null,
            enabled: m.enabled !== false,
            metadata: (m.metadata ?? {}) as Record<string, unknown>,
            strategy: m.strategy ?? "fallback",
            balance: m.balance,
          },
          version,
          now,
        );
        m.bindings.forEach((b, i) => {
          const channelId = channelIdByName.get(b.target);
          if (channelId === undefined)
            throw new ConfigStoreError(`model "${m.name}" binds unknown target "${b.target}"`);
          this.insertBindingRow(modelId, {
            channelId,
            upstreamModel: b.model ?? m.name,
            priority: b.priority ?? i,
            weight: b.weight ?? 1,
            enabled: b.enabled !== false,
            params: b.params ?? {},
          });
        });
      }
      for (const key of SETTING_KEYS) {
        const value = (config as unknown as Record<string, unknown>)[key];
        if (value !== undefined) this.writeSetting(key, value, version, now);
      }
      this.setMeta("yaml_runtime_hash", yamlHash);
      // Explicit published models (models: section) vs derived from targets[].models.
      this.setMeta("models_explicit", config.models !== undefined ? "1" : "0");
      this.setMeta("settings_revision", String(version));
      this.setMeta("yaml_imported_at", now);
      if (!this.isInitialized()) this.setMeta("initialized_at", now);
      this.finishVersion(version);
      this.audit(actor, "import", "runtime_config", null, { channels: channels.length }, now);
      return { version, createdAt: now, actor, summary };
    });
    const info = write();
    for (const c of channels)
      for (const k of c.keys) if (k.plaintext !== undefined) this.keyCache.set(k.id, k.plaintext);
    return info;
  }

  // ── Read (Admin API; never on the request path) ──

  private keyRows(channelId?: string): KeyRow[] {
    const sql =
      "SELECT id, channel_id, kind, value, hint, enabled, status, last_error, last_error_at, weight, position, revision FROM channel_keys" +
      (channelId ? " WHERE channel_id = ?" : "") +
      " ORDER BY position, created_at";
    return (channelId ? this.db.query(sql).all(channelId) : this.db.query(sql).all()) as KeyRow[];
  }

  private channelView(r: ChannelRow, keys: readonly KeyRow[]): ChannelView {
    return {
      id: r.id,
      name: r.name,
      preset: r.preset,
      ...(r.base_url !== null ? { baseURL: r.base_url } : {}),
      enabled: r.enabled === 1,
      priority: r.priority,
      models: JSON.parse(r.models_json) as string[],
      settings: JSON.parse(r.settings_json) as Record<string, unknown>,
      urlPolicy: r.url_policy,
      revision: r.revision,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      keys: keys.map((k) => ({
        id: k.id,
        kind: k.kind,
        hint: k.hint,
        enabled: k.enabled === 1,
        status: k.status,
        weight: k.weight,
        lastError: k.last_error,
        lastErrorAt: k.last_error_at,
        revision: k.revision,
      })),
    };
  }

  listChannels(): ChannelView[] {
    const byChannel = new Map<string, KeyRow[]>();
    for (const k of this.keyRows()) byChannel.set(k.channel_id, [...(byChannel.get(k.channel_id) ?? []), k]);
    const rows = this.db.query("SELECT * FROM channels ORDER BY priority, name").all() as ChannelRow[];
    return rows.map((r) => this.channelView(r, byChannel.get(r.id) ?? []));
  }

  getChannel(id: string): ChannelView | undefined {
    const r = this.db.query("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | null;
    return r ? this.channelView(r, this.keyRows(r.id)) : undefined;
  }

  private bindingRows(modelId?: string): BindingRow[] {
    const sql = `SELECT b.id, b.model_id, b.channel_id, c.name AS channel, b.upstream_model, b.priority, b.weight, b.enabled, b.overrides_json
       FROM model_bindings b JOIN channels c ON c.id = b.channel_id${modelId ? " WHERE b.model_id = ?" : ""}
       ORDER BY b.priority, b.rowid`;
    return (modelId ? this.db.query(sql).all(modelId) : this.db.query(sql).all()) as BindingRow[];
  }

  private modelView(m: ModelRow, bindings: readonly BindingRow[]): ModelView {
    const routing = JSON.parse(m.routing_json) as { strategy?: "fallback" | "loadbalance"; balance?: string };
    return {
      id: m.id,
      name: m.name,
      displayName: m.display_name,
      description: m.description,
      enabled: m.enabled === 1,
      metadata: JSON.parse(m.metadata_json) as Record<string, unknown>,
      strategy: routing.strategy === "loadbalance" ? "loadbalance" : "fallback",
      balance: (routing.balance as ModelView["balance"] | undefined) ?? "weighted",
      revision: m.revision,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      bindings: bindings.map((b) => ({
        id: b.id,
        channelId: b.channel_id,
        channel: b.channel,
        upstreamModel: b.upstream_model,
        priority: b.priority,
        weight: b.weight,
        enabled: b.enabled === 1,
        params: JSON.parse(b.overrides_json) as Record<string, unknown>,
      })),
    };
  }

  listModels(): ModelView[] {
    const byModel = new Map<string, BindingRow[]>();
    for (const b of this.bindingRows()) byModel.set(b.model_id, [...(byModel.get(b.model_id) ?? []), b]);
    const rows = this.db.query("SELECT * FROM models ORDER BY created_at, rowid").all() as ModelRow[];
    return rows.map((m) => this.modelView(m, byModel.get(m.id) ?? []));
  }

  getModel(id: string): ModelView | undefined {
    const m = this.db.query("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | null;
    return m ? this.modelView(m, this.bindingRows(m.id)) : undefined;
  }

  getSettings(): SettingsView {
    const settings = new Map(
      (
        this.db.query("SELECT key, value_json FROM runtime_settings").all() as Array<{
          key: string;
          value_json: string;
        }>
      ).map((r) => [r.key, JSON.parse(r.value_json) as unknown]),
    );
    return {
      strategy: settings.get("strategy") ?? null,
      aliases: (settings.get("aliases") as Record<string, string> | undefined) ?? {},
      plugins: (settings.get("plugins") as unknown[] | undefined) ?? [],
      compatibility: settings.get("compatibility") ?? null,
      limits: (settings.get("limits") as Record<string, unknown> | undefined) ?? {},
      modelSource: this.getMeta("models_explicit") === "1" ? "explicit" : "derived",
      revision: Number(this.getMeta("settings_revision") ?? "1"),
    };
  }

  /** Latest config version number (0 when none). */
  headVersion(): number {
    const row = this.db.query("SELECT MAX(version) AS v FROM config_versions").get() as { v: number | null };
    return row.v ?? 0;
  }

  listVersions(limit = 50, before?: number): ConfigVersionInfo[] {
    const rows = (
      before !== undefined
        ? this.db
            .query(
              "SELECT version, created_at, actor, summary FROM config_versions WHERE version < ? ORDER BY version DESC LIMIT ?",
            )
            .all(before, limit)
        : this.db
            .query("SELECT version, created_at, actor, summary FROM config_versions ORDER BY version DESC LIMIT ?")
            .all(limit)
    ) as Array<{ version: number; created_at: string; actor: string | null; summary: string }>;
    return rows.map((r) => ({ version: r.version, createdAt: r.created_at, actor: r.actor, summary: r.summary }));
  }

  /** One version with its snapshot (key ciphertexts removed: hints only). */
  getVersion(version: number): (ConfigVersionInfo & { snapshot: unknown }) | undefined {
    const row = this.db
      .query("SELECT version, created_at, actor, summary, snapshot_json FROM config_versions WHERE version = ?")
      .get(version) as {
      version: number;
      created_at: string;
      actor: string | null;
      summary: string;
      snapshot_json: string;
    } | null;
    if (!row) return undefined;
    const snap = JSON.parse(row.snapshot_json || "{}") as { keys?: Array<Record<string, unknown>> };
    if (Array.isArray(snap.keys)) {
      snap.keys = snap.keys.map(({ value: _value, ...rest }) => rest);
    }
    return { version: row.version, createdAt: row.created_at, actor: row.actor, summary: row.summary, snapshot: snap };
  }

  listAudit(limit = 100, before?: number): AuditEntry[] {
    const rows = (
      before !== undefined
        ? this.db
            .query(
              "SELECT id, at, actor, action, resource_type, resource_id, detail_json FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?",
            )
            .all(before, limit)
        : this.db
            .query(
              "SELECT id, at, actor, action, resource_type, resource_id, detail_json FROM audit_log ORDER BY id DESC LIMIT ?",
            )
            .all(limit)
    ) as Array<{
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

  // ── Runtime config (built from the store; key plaintexts from the cache) ──

  /**
   * The runtime sections as a config fragment (decrypted keys in memory
   * only). Throws ConfigStoreError when an encrypted key cannot be
   * decrypted (missing or wrong GATEWAY_SECRET_KEY).
   */
  async loadRuntimeSections(): Promise<RuntimeSections> {
    await this.warmKeys();
    return this.buildRuntimeSections();
  }

  /**
   * Synchronous build from the current rows (inside a write transaction it
   * sees the uncommitted writes). Every encrypted key must be in the cache.
   *
   * Channels: every channel, disabled ones as `enabled: false` (their
   * bindings are kept and skipped at routing). Keys: only enabled keys with
   * status ok, each with its store id (key events map back to the row).
   */
  buildRuntimeSections(): RuntimeSections {
    const channels = this.db.query("SELECT * FROM channels ORDER BY priority, name").all() as ChannelRow[];
    const keysByChannel = new Map<string, KeyRow[]>();
    for (const k of this.keyRows()) keysByChannel.set(k.channel_id, [...(keysByChannel.get(k.channel_id) ?? []), k]);
    const targets: TargetConfig[] = [];
    for (const ch of channels) {
      const apiKeys: TargetKeyConfig[] = [];
      for (const k of keysByChannel.get(ch.id) ?? []) {
        if (k.enabled !== 1 || k.status !== "ok") continue;
        let key: string;
        if (k.kind === "env_ref") key = k.value;
        else {
          const plain = this.keyCache.get(k.id);
          if (plain === undefined) {
            throw new ConfigStoreError(`the upstream key ${k.id} of channel "${ch.name}" is not decrypted`);
          }
          key = plain;
        }
        apiKeys.push({ id: k.id, key, ...(k.weight !== 1 ? { weight: k.weight } : {}) });
      }
      const models = JSON.parse(ch.models_json) as string[];
      targets.push({
        ...(JSON.parse(ch.settings_json) as Partial<TargetConfig>),
        name: ch.name,
        provider: ch.preset,
        apiKeys,
        ...(ch.base_url !== null ? { baseURL: ch.base_url } : {}),
        ...(models.length > 0 ? { models } : {}),
        ...(ch.enabled !== 1 ? { enabled: false } : {}),
        ...(ch.url_policy === "public" ? { publicNetworkOnly: true } : {}),
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
    if (this.getMeta("models_explicit") === "1") out["models"] = this.buildModels();
    if (!out["strategy"]) throw new ConfigStoreError("runtime config store has no routing strategy");
    return out as RuntimeSections;
  }

  /**
   * Published models in config shape: every model, every binding (disabled
   * ones as `enabled: false`). A model whose bindings cannot serve (all
   * disabled, or on disabled channels) stays published and is answered 503
   * model_unavailable at request time; its aliases keep resolving.
   */
  private buildModels(): PublishedModelConfig[] {
    const byModel = new Map<string, BindingRow[]>();
    for (const b of this.bindingRows()) byModel.set(b.model_id, [...(byModel.get(b.model_id) ?? []), b]);
    const models = this.db.query("SELECT * FROM models ORDER BY created_at, rowid").all() as ModelRow[];
    return models.map((m) => {
      const rows = byModel.get(m.id) ?? [];
      // Priorities are written out unless they are just the list order (the default).
      const explicitPriority = rows.some((b, i) => b.priority !== i);
      const list: ModelBindingConfig[] = rows.map((b) => {
        const params = JSON.parse(b.overrides_json) as Record<string, unknown>;
        return {
          target: b.channel,
          ...(b.upstream_model !== m.name ? { model: b.upstream_model } : {}),
          ...(explicitPriority ? { priority: b.priority } : {}),
          ...(b.weight !== 1 ? { weight: b.weight } : {}),
          ...(b.enabled !== 1 ? { enabled: false } : {}),
          ...(Object.keys(params).length > 0 ? { params } : {}),
        };
      });
      const metadata = JSON.parse(m.metadata_json) as Record<string, unknown>;
      const routing = JSON.parse(m.routing_json) as { strategy?: "fallback" | "loadbalance"; balance?: string };
      return {
        name: m.name,
        ...(m.enabled === 1 ? {} : { enabled: false }),
        ...(m.display_name !== null ? { displayName: m.display_name } : {}),
        ...(m.description !== null ? { description: m.description } : {}),
        ...(routing.strategy === "loadbalance" ? { strategy: "loadbalance" as const } : {}),
        ...(routing.balance !== undefined ? { balance: routing.balance as PublishedModelConfig["balance"] } : {}),
        bindings: list,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    });
  }

  // ── Writes ──

  /**
   * Run one change atomically (plan §3.2):
   *   reserve a config version → `write` (the resource rows, revision = that
   *   version) → version snapshot (key ciphertext only) → audit row →
   *   `apply(runtime sections)` (validate, build and swap the runtime) →
   *   commit.
   * Anything thrown — a conflict in `write`, a validation or build failure in
   * `apply` — rolls the whole transaction back: nothing was written and, as
   * apply swaps last, the old runtime keeps serving.
   */
  mutate<T>(
    meta: MutationMeta,
    write: (version: number, now: string) => T,
    apply: (runtime: RuntimeSections) => void,
    cacheKeys: readonly PreparedKey[] = [],
  ): { result: T; version: ConfigVersionInfo } {
    // The cache is filled first so the runtime build sees new keys; on
    // failure the extra entries are harmless (ids are never reused).
    for (const k of cacheKeys) if (k.plaintext !== undefined) this.keyCache.set(k.id, k.plaintext);
    const run = this.db.transaction(() => {
      const now = new Date().toISOString();
      if (meta.expectHead !== undefined) this.expectHeadVersion(meta.expectHead);
      const version = this.reserveVersion(meta.actor, meta.summary, now);
      const result = write(version, now);
      this.finishVersion(version);
      this.audit(meta.actor, meta.action, meta.resourceType, meta.resourceId ?? null, meta.detail, now);
      apply(this.buildRuntimeSections());
      return { result, version: { version, createdAt: now, actor: meta.actor, summary: meta.summary } };
    });
    return run.immediate();
  }

  /** Throws 404 / 409 unless `id` exists in `table` with revision `expected`. */
  expectRevision(table: "channels" | "models", id: string, expected: number, label: string): void {
    const row = this.db.query(`SELECT revision FROM ${table} WHERE id = ?`).get(id) as { revision: number } | null;
    if (!row) throw new ConfigNotFoundError(`${label} ${id} not found`);
    if (row.revision !== expected) {
      throw new ConfigConflictError(
        `${label} ${id} was changed by someone else (revision ${row.revision}, If-Match ${expected}); reload it and retry`,
        "revision_mismatch",
        row.revision,
      );
    }
  }

  expectSettingsRevision(expected: number): void {
    const current = Number(this.getMeta("settings_revision") ?? "1");
    if (current !== expected) {
      throw new ConfigConflictError(
        `settings were changed by someone else (revision ${current}, If-Match ${expected}); reload and retry`,
        "revision_mismatch",
        current,
      );
    }
  }

  expectHeadVersion(expected: number): void {
    const head = this.headVersion();
    if (head !== expected) {
      throw new ConfigConflictError(
        `the config changed since version ${expected} (now ${head}); reload and retry`,
        "revision_mismatch",
        head,
      );
    }
  }

  private nameTaken(table: "channels" | "models", name: string, exceptId?: string): boolean {
    const row = this.db.query(`SELECT id FROM ${table} WHERE name = ?`).get(name) as { id: string } | null;
    return row !== null && row.id !== exceptId;
  }

  insertChannelRow(
    c: {
      id: string;
      name: string;
      preset: string;
      baseURL: string | null;
      enabled: boolean;
      priority: number;
      models: readonly string[];
      settings: Record<string, unknown>;
      urlPolicy: "public" | "trusted";
    },
    version: number,
    now: string,
  ): void {
    if (this.nameTaken("channels", c.name)) {
      throw new ConfigConflictError(`a channel named "${c.name}" already exists`, "name_taken");
    }
    this.db
      .query(
        `INSERT INTO channels (id, name, preset, base_url, enabled, priority, models_json, settings_json, url_policy, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.name,
        c.preset,
        c.baseURL,
        c.enabled ? 1 : 0,
        c.priority,
        JSON.stringify(c.models),
        JSON.stringify(c.settings),
        c.urlPolicy,
        version,
        now,
        now,
      );
  }

  updateChannelRow(
    id: string,
    patch: Partial<{
      name: string;
      preset: string;
      baseURL: string | null;
      enabled: boolean;
      priority: number;
      models: readonly string[];
      settings: Record<string, unknown>;
      urlPolicy: "public" | "trusted";
    }>,
    version: number,
    now: string,
  ): void {
    if (patch.name !== undefined && this.nameTaken("channels", patch.name, id)) {
      throw new ConfigConflictError(`a channel named "${patch.name}" already exists`, "name_taken");
    }
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    const col = (c: string, v: string | number | null) => {
      sets.push(`${c} = ?`);
      args.push(v);
    };
    if (patch.name !== undefined) col("name", patch.name);
    if (patch.preset !== undefined) col("preset", patch.preset);
    if (patch.baseURL !== undefined) col("base_url", patch.baseURL);
    if (patch.enabled !== undefined) col("enabled", patch.enabled ? 1 : 0);
    if (patch.priority !== undefined) col("priority", patch.priority);
    if (patch.models !== undefined) col("models_json", JSON.stringify(patch.models));
    if (patch.settings !== undefined) col("settings_json", JSON.stringify(patch.settings));
    if (patch.urlPolicy !== undefined) col("url_policy", patch.urlPolicy);
    col("revision", version);
    col("updated_at", now);
    this.db.query(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** Bump a channel's revision (its keys changed). */
  touchChannel(id: string, version: number, now: string): void {
    this.db.query("UPDATE channels SET revision = ?, updated_at = ? WHERE id = ?").run(version, now, id);
  }

  deleteChannelRow(id: string): void {
    const used = this.db
      .query(
        "SELECT DISTINCT m.name FROM model_bindings b JOIN models m ON m.id = b.model_id WHERE b.channel_id = ? ORDER BY m.name",
      )
      .all(id) as Array<{ name: string }>;
    if (used.length > 0) {
      throw new ConfigConflictError(
        `the channel is bound by model(s) ${used.map((u) => `"${u.name}"`).join(", ")}; remove those bindings first`,
        "channel_in_use",
      );
    }
    this.db.query("DELETE FROM channels WHERE id = ?").run(id);
  }

  insertKeyRow(channelId: string, k: PreparedKey, position: number, version: number, now: string): void {
    this.db
      .query(
        `INSERT INTO channel_keys (id, channel_id, kind, value, hint, enabled, status, position, weight, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?)`,
      )
      .run(k.id, channelId, k.kind, k.value, k.hint, k.enabled ? 1 : 0, position, k.weight, version, now, now);
  }

  nextKeyPosition(channelId: string): number {
    const row = this.db.query("SELECT MAX(position) AS p FROM channel_keys WHERE channel_id = ?").get(channelId) as {
      p: number | null;
    };
    return (row.p ?? -1) + 1;
  }

  /** Throws 404 unless key `keyId` belongs to `channelId`; returns its hint. */
  expectKey(channelId: string, keyId: string): { hint: string } {
    const row = this.db
      .query("SELECT hint FROM channel_keys WHERE id = ? AND channel_id = ?")
      .get(keyId, channelId) as { hint: string } | null;
    if (!row) throw new ConfigNotFoundError(`key ${keyId} not found on channel ${channelId}`);
    return row;
  }

  /** Enable / disable / reweight a key. Enabling clears an automatic status (invalid / quota). */
  updateKeyRow(keyId: string, patch: { enabled?: boolean; weight?: number }, version: number, now: string): void {
    const sets = ["revision = ?", "updated_at = ?"];
    const args: Array<string | number | null> = [version, now];
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      args.push(patch.enabled ? 1 : 0);
      if (patch.enabled) sets.push("status = 'ok'", "last_error = NULL", "last_error_at = NULL");
    }
    if (patch.weight !== undefined) {
      sets.push("weight = ?");
      args.push(patch.weight);
    }
    this.db.query(`UPDATE channel_keys SET ${sets.join(", ")} WHERE id = ?`).run(...args, keyId);
  }

  deleteKeyRow(keyId: string): void {
    this.db.query("DELETE FROM channel_keys WHERE id = ?").run(keyId);
    this.keyCache.delete(keyId);
  }

  insertModelRow(
    m: {
      id: string;
      name: string;
      displayName: string | null;
      description: string | null;
      enabled: boolean;
      metadata: Record<string, unknown>;
      strategy: "fallback" | "loadbalance";
      balance?: string;
    },
    version: number,
    now: string,
  ): void {
    if (this.nameTaken("models", m.name)) {
      throw new ConfigConflictError(`a model named "${m.name}" already exists`, "name_taken");
    }
    this.db
      .query(
        `INSERT INTO models (id, name, display_name, description, enabled, metadata_json, routing_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.name,
        m.displayName,
        m.description,
        m.enabled ? 1 : 0,
        JSON.stringify(m.metadata),
        JSON.stringify({ strategy: m.strategy, ...(m.balance !== undefined ? { balance: m.balance } : {}) }),
        version,
        now,
        now,
      );
  }

  updateModelRow(
    id: string,
    patch: Partial<{
      name: string;
      displayName: string | null;
      description: string | null;
      enabled: boolean;
      metadata: Record<string, unknown>;
      strategy: "fallback" | "loadbalance";
      balance: string;
    }>,
    version: number,
    now: string,
  ): void {
    if (patch.name !== undefined && this.nameTaken("models", patch.name, id)) {
      throw new ConfigConflictError(`a model named "${patch.name}" already exists`, "name_taken");
    }
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    const col = (c: string, v: string | number | null) => {
      sets.push(`${c} = ?`);
      args.push(v);
    };
    if (patch.name !== undefined) col("name", patch.name);
    if (patch.displayName !== undefined) col("display_name", patch.displayName);
    if (patch.description !== undefined) col("description", patch.description);
    if (patch.enabled !== undefined) col("enabled", patch.enabled ? 1 : 0);
    if (patch.metadata !== undefined) col("metadata_json", JSON.stringify(patch.metadata));
    if (patch.strategy !== undefined || patch.balance !== undefined) {
      const row = this.db.query("SELECT routing_json FROM models WHERE id = ?").get(id) as { routing_json: string };
      const routing = { ...(JSON.parse(row.routing_json) as Record<string, unknown>) };
      if (patch.strategy !== undefined) routing["strategy"] = patch.strategy;
      if (patch.balance !== undefined) routing["balance"] = patch.balance;
      col("routing_json", JSON.stringify(routing));
    }
    col("revision", version);
    col("updated_at", now);
    this.db.query(`UPDATE models SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  deleteModelRow(id: string): void {
    this.db.query("DELETE FROM models WHERE id = ?").run(id);
  }

  /** Resolve a channel reference (id or name) to its id; throws 404-ish ConfigStoreError. */
  channelIdOf(ref: { channelId?: string; channel?: string }): string {
    const row = (
      ref.channelId !== undefined
        ? this.db.query("SELECT id FROM channels WHERE id = ?").get(ref.channelId)
        : this.db.query("SELECT id FROM channels WHERE name = ?").get(ref.channel ?? "")
    ) as { id: string } | null;
    if (!row) {
      throw new ConfigStoreError(`binding references unknown channel "${ref.channelId ?? ref.channel}"`);
    }
    return row.id;
  }

  insertBindingRow(
    modelId: string,
    b: {
      channelId: string;
      upstreamModel: string;
      priority: number;
      weight: number;
      enabled: boolean;
      params: Record<string, unknown>;
    },
  ): void {
    this.db
      .query(
        `INSERT INTO model_bindings (id, model_id, channel_id, upstream_model, priority, weight, enabled, overrides_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("bnd"),
        modelId,
        b.channelId,
        b.upstreamModel,
        b.priority,
        b.weight,
        b.enabled ? 1 : 0,
        JSON.stringify(b.params),
      );
  }

  deleteBindings(modelId: string): void {
    this.db.query("DELETE FROM model_bindings WHERE model_id = ?").run(modelId);
  }

  writeSetting(key: SettingKey, value: unknown, version: number, now: string): void {
    if (value === null || value === undefined) {
      this.db.query("DELETE FROM runtime_settings WHERE key = ?").run(key);
      return;
    }
    this.db
      .query(
        "INSERT INTO runtime_settings (key, value_json, revision, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, revision = excluded.revision, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(value), version, now);
  }

  setSettingsRevision(version: number): void {
    this.setMeta("settings_revision", String(version));
  }

  /**
   * Switch published models from derived (targets[].models under the global
   * strategy) to explicit rows, keeping what is served: one model per
   * derived name, bound to the channels that list it — loadbalance with the
   * channel weights when the global strategy is loadbalance, else fallback
   * in the global strategy's target order.
   */
  materializeDerivedModels(version: number, now: string): number {
    const settings = this.getSettings();
    const strategy = (settings.strategy ?? {}) as {
      mode?: string;
      targets?: string[];
      weights?: Record<string, number>;
    };
    const channels = this.listChannels();
    const order = new Map<string, number>();
    for (const [i, t] of (strategy.targets ?? []).entries()) order.set(t, i);
    const rank = (name: string) =>
      order.get(name) ?? (strategy.targets?.length ?? 0) + channels.findIndex((c) => c.name === name);
    const byModel = new Map<string, ChannelView[]>();
    for (const c of channels) {
      for (const m of c.models) byModel.set(m, [...(byModel.get(m) ?? []), c]);
    }
    const lb = strategy.mode === "loadbalance";
    let count = 0;
    for (const [name, list] of byModel) {
      if (this.nameTaken("models", name)) continue;
      const id = newId("mdl");
      this.insertModelRow(
        {
          id,
          name,
          displayName: null,
          description: null,
          enabled: true,
          metadata: {},
          strategy: lb ? "loadbalance" : "fallback",
        },
        version,
        now,
      );
      [...list]
        .sort((a, b) => rank(a.name) - rank(b.name))
        .forEach((c, i) => {
          const weight = (c.settings["weight"] as number | undefined) ?? strategy.weights?.[c.name] ?? 1;
          this.insertBindingRow(id, {
            channelId: c.id,
            upstreamModel: name,
            priority: i,
            weight: lb ? weight : 1,
            enabled: true,
            params: {},
          });
        });
      count++;
    }
    this.setMeta("models_explicit", "1");
    return count;
  }

  setModelSource(source: "explicit" | "derived"): void {
    this.setMeta("models_explicit", source === "explicit" ? "1" : "0");
  }

  // ── Rollback ──

  private parseSnapshot(version: number): SnapshotData {
    const row = this.db.query("SELECT snapshot_json FROM config_versions WHERE version = ?").get(version) as {
      snapshot_json: string;
    } | null;
    if (!row) throw new ConfigNotFoundError(`config version ${version} not found`);
    const snap = JSON.parse(row.snapshot_json || "{}") as SnapshotData;
    if (!Array.isArray(snap.channels) || !Array.isArray(snap.keys)) {
      throw new ConfigStoreError(`config version ${version} has no restorable snapshot`);
    }
    return snap;
  }

  /** Decrypt the keys of `version`'s snapshot into the cache (async: before restoreVersion). */
  async prepareRestore(version: number): Promise<void> {
    const snap = this.parseSnapshot(version);
    await this.warmKeys(
      (snap.keys ?? []).map((k) => ({
        id: String(k["id"]),
        channel_id: String(k["channel_id"]),
        kind: k["kind"] as "encrypted" | "env_ref",
        value: String(k["value"]),
      })),
    );
  }

  /**
   * Replace every runtime row with `version`'s snapshot (inside mutate).
   * Restored rows get the new version as revision, so an ETag from before
   * the rollback never matches by accident.
   */
  restoreVersion(version: number, newVersion: number, now: string): void {
    const snap = this.parseSnapshot(version);
    this.db.exec(
      "DELETE FROM model_bindings; DELETE FROM models; DELETE FROM channel_keys; DELETE FROM channels; DELETE FROM runtime_settings;",
    );
    const insert = (
      table: string,
      columns: readonly string[],
      row: Record<string, unknown>,
      fixed: Record<string, unknown>,
    ) => {
      const cols = columns.filter((c) => c in row || c in fixed);
      const vals = cols.map((c) => {
        const v = c in fixed ? fixed[c] : row[c];
        return v === undefined ? null : (v as string | number | null);
      });
      this.db
        .query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .run(...(vals as Array<string | number | null>));
    };
    for (const c of snap.channels) {
      const settings = typeof c["settings_json"] === "string" ? stripRemovedSettings(c["settings_json"]) : undefined;
      insert("channels", CHANNEL_COLUMNS, c, {
        revision: newVersion,
        updated_at: now,
        ...(settings !== undefined ? { settings_json: settings } : {}),
      });
    }
    for (const k of snap.keys)
      insert("channel_keys", KEY_COLUMNS, k, {
        revision: newVersion,
        updated_at: now,
        created_at: k["created_at"] ?? now,
      });
    for (const m of snap.models ?? []) insert("models", MODEL_COLUMNS, m, { revision: newVersion, updated_at: now });
    for (const b of snap.bindings ?? []) insert("model_bindings", BINDING_COLUMNS, b, {});
    for (const s of snap.settings ?? []) {
      insert("runtime_settings", ["key", "value_json", "revision", "updated_at"], s, {
        revision: newVersion,
        updated_at: now,
      });
    }
    if (snap.meta?.models_explicit !== undefined) this.setMeta("models_explicit", snap.meta.models_explicit);
    this.setMeta("settings_revision", String(newVersion));
  }

  // ── Key health (asynchronous, outside config versions) ──

  /**
   * Persist an automatic key disable (upstream 401/402) with an audit row.
   * Not a config change: no version, revisions unchanged. Ignored when the
   * key is gone or was changed by an operator since (its revision moved on).
   */
  recordKeyDisabled(e: {
    keyId: string;
    status: "invalid" | "quota";
    error: string;
    at: string;
    httpStatus: number;
  }): boolean {
    const row = this.db
      .query("SELECT channel_id, hint FROM channel_keys WHERE id = ? AND enabled = 1 AND status = 'ok'")
      .get(e.keyId) as { channel_id: string; hint: string } | null;
    if (!row) return false;
    this.db.transaction(() => {
      this.db
        .query("UPDATE channel_keys SET status = ?, last_error = ?, last_error_at = ? WHERE id = ?")
        .run(e.status, e.error, e.at, e.keyId);
      this.audit(
        "system:key-health",
        "key_auto_disabled",
        "channel_key",
        e.keyId,
        { channelId: row.channel_id, hint: row.hint, status: e.status, httpStatus: e.httpStatus, error: e.error },
        e.at,
      );
    })();
    return true;
  }

  /** Record an audit entry outside a config change (e.g. a refused write is not audited; tests). */
  auditOnly(actor: string, action: string, resourceType: string, resourceId: string | null, detail: unknown): void {
    this.audit(actor, action, resourceType, resourceId, detail, new Date().toISOString());
  }

  // ── Backups ──

  /**
   * Online copy of the database before a change (plan §9.2: `VACUUM INTO`),
   * at most one per `minIntervalMs`, keeping the newest `keep` files next
   * to the database. No-op for an in-memory store.
   */
  backup(keep = 5, minIntervalMs = 0): string | undefined {
    if (this.path === ":memory:") return undefined;
    const now = Date.now();
    if (now - this.lastBackupAt < minIntervalMs) return undefined;
    this.lastBackupAt = now;
    const dir = dirname(this.path);
    const base = basename(this.path);
    const target = join(dir, `${base}.backup-${new Date(now).toISOString().replace(/[:.]/g, "-")}.bak`);
    try {
      this.db.query("VACUUM INTO ?").run(target);
      chmodSync(target, 0o600);
    } catch (err) {
      console.error(`[config-store] backup failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const old = readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.backup-`) && f.endsWith(".bak"))
      .sort();
    for (const f of old.slice(0, Math.max(0, old.length - keep))) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        // already gone
      }
    }
    return target;
  }

  // ── Internals ──

  /** Snapshot of every runtime row (key ciphertext/env refs only; never plaintext). */
  private snapshotJson(): string {
    const channels = this.db.query("SELECT * FROM channels ORDER BY priority, name").all();
    const keys = this.db
      .query(
        "SELECT id, channel_id, kind, value, hint, enabled, status, last_error, last_error_at, weight, position, created_at FROM channel_keys ORDER BY position, created_at",
      )
      .all();
    const models = this.db.query("SELECT * FROM models ORDER BY created_at, rowid").all();
    const bindings = this.db.query("SELECT * FROM model_bindings ORDER BY rowid").all();
    const settings = this.db.query("SELECT key, value_json FROM runtime_settings ORDER BY key").all();
    const meta = { models_explicit: this.getMeta("models_explicit") ?? "0" };
    return JSON.stringify({ format: SNAPSHOT_FORMAT, channels, keys, models, bindings, settings, meta });
  }

  private reserveVersion(actor: string, summary: string, at: string): number {
    const row = this.db
      .query(
        "INSERT INTO config_versions (created_at, actor, summary, snapshot_json) VALUES (?, ?, ?, '') RETURNING version",
      )
      .get(at, actor, summary) as { version: number };
    return row.version;
  }

  private finishVersion(version: number): void {
    this.db.query("UPDATE config_versions SET snapshot_json = ? WHERE version = ?").run(this.snapshotJson(), version);
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

interface SnapshotData {
  format?: number;
  channels: Array<Record<string, unknown>>;
  keys: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, unknown>>;
  settings?: Array<Record<string, unknown>>;
  meta?: { models_explicit?: string };
}

const CHANNEL_COLUMNS = [
  "id",
  "name",
  "preset",
  "base_url",
  "enabled",
  "priority",
  "models_json",
  "settings_json",
  "url_policy",
  "revision",
  "created_at",
  "updated_at",
] as const;
const KEY_COLUMNS = [
  "id",
  "channel_id",
  "kind",
  "value",
  "hint",
  "enabled",
  "status",
  "last_error",
  "last_error_at",
  "weight",
  "position",
  "revision",
  "created_at",
  "updated_at",
] as const;
const MODEL_COLUMNS = [
  "id",
  "name",
  "display_name",
  "description",
  "enabled",
  "metadata_json",
  "routing_json",
  "revision",
  "created_at",
  "updated_at",
] as const;
const BINDING_COLUMNS = [
  "id",
  "model_id",
  "channel_id",
  "upstream_model",
  "priority",
  "weight",
  "enabled",
  "overrides_json",
] as const;
