/**
 * `ai-gateway keys ...` — manage the API key store directly, without the
 * HTTP admin API. This is the recovery path when no admin credential works
 * any more (e.g. every admin key was revoked: ADMIN_BOOTSTRAP_KEY stays
 * refused once the bootstrap latch is set, see auth/bootstrap.ts).
 *
 *   ai-gateway keys create [--admin] [--read-only] [--name N] [--expires ISO] [--json] -c <config>
 *   ai-gateway keys list   [--json] -c <config>
 *   ai-gateway keys revoke <id> -c <config>
 *
 * It opens the same database as `serve` (<data dir>/api-keys.sqlite, data dir
 * = --data-dir, GATEWAY_DATA_DIR or ./.data) in WAL mode with a busy timeout,
 * so it is safe to run while the server is up; the server sees changes on the
 * next request. A new key's secret is written once, to stdout only; nothing
 * else (config values, secrets) is printed, and diagnostics go to stderr.
 */

import { existsSync } from "node:fs";
import { loadConfigFromPath } from "../config/loader.js";
import {
  type APIKey,
  KeyNotFoundError,
  KeyStore,
  SCOPE_ADMIN,
  SCOPE_INFERENCE,
  SCOPE_READ_ONLY,
  keyStorePath,
  openKeyStoreDatabase,
  resolveDataDir,
} from "../persistence/key-store.js";

export interface KeysIO {
  /** stdout: the new key (create), the listing (list). */
  out(line: string): void;
  /** stderr: diagnostics and errors. */
  err(line: string): void;
}

const defaultIO: KeysIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export interface ParsedKeysArgs {
  sub?: string;
  configPath?: string;
  dataDir?: string;
  admin: boolean;
  readOnly: boolean;
  name?: string;
  expires?: string;
  json: boolean;
  id?: string;
  help: boolean;
  error?: string;
}

/** Parse the arguments after `keys`. */
export function parseKeysArgs(args: readonly string[]): ParsedKeysArgs {
  const parsed: ParsedKeysArgs = { admin: false, readOnly: false, json: false, help: false };
  const positional: string[] = [];
  const value = (i: number, flag: string): string | undefined => {
    const v = args[i];
    if (v === undefined || v.startsWith("-")) {
      parsed.error ??= `${flag} needs a value`;
      return undefined;
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "-c":
      case "--config":
        parsed.configPath = value(++i, arg);
        break;
      case "--data-dir":
        parsed.dataDir = value(++i, arg);
        break;
      case "--name":
        parsed.name = value(++i, arg);
        break;
      case "--expires":
        parsed.expires = value(++i, arg);
        break;
      case "--admin":
        parsed.admin = true;
        break;
      case "--read-only":
        parsed.readOnly = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        if (arg.startsWith("-")) parsed.error ??= `unknown option "${arg}"`;
        else positional.push(arg);
    }
  }
  parsed.sub = positional[0];
  if (parsed.sub === "revoke") parsed.id = positional[1];
  const maxPositional = parsed.sub === "revoke" ? 2 : 1;
  if (positional.length > maxPositional) parsed.error ??= `unexpected argument "${positional[maxPositional]}"`;
  return parsed;
}

export function keysUsage(): string {
  return `Usage:
  ai-gateway keys create [--admin] [--read-only] [--name <name>] [--expires <ISO date>] [--json] -c <config>
  ai-gateway keys list   [--json] -c <config>
  ai-gateway keys revoke <id> -c <config>

Manage the API key store directly (no running server needed; safe while it runs).
Recovery: if no admin credential works any more, \`keys create --admin\` mints a new
admin key. ADMIN_BOOTSTRAP_KEY is refused for good once the first admin key exists.

Options:
  -c, --config <path>   Config file (validated; required)
  --data-dir <dir>      Data directory (default: GATEWAY_DATA_DIR or ./.data), same as serve
  --admin               Create with "admin" scope (full management)
  --read-only           Create with "read_only" scope (default without either: "inference")
  --name <name>         Key name (default: cli-admin / cli-read-only / cli-key)
  --expires <ISO date>  Expiry, e.g. 2027-01-01T00:00:00Z (must be in the future)
  --json                Machine-readable output on stdout

The new key's secret is printed once, on stdout, and never stored or logged.`;
}

function status(key: APIKey, now: Date): string {
  if (!key.active || key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && now > key.expiresAt) return "expired";
  return "active";
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Run `keys <sub> ...`; returns the process exit code. */
export async function keysCommand(args: readonly string[], io: KeysIO = defaultIO): Promise<number> {
  const p = parseKeysArgs(args);
  if (p.help) {
    io.out(keysUsage());
    return 0;
  }
  if (p.error !== undefined) {
    io.err(`Error: ${p.error}\n`);
    io.err(keysUsage());
    return 1;
  }
  if (p.sub !== "create" && p.sub !== "list" && p.sub !== "revoke") {
    io.err(p.sub === undefined ? "Error: missing keys subcommand\n" : `Error: unknown keys subcommand "${p.sub}"\n`);
    io.err(keysUsage());
    return 1;
  }
  if (p.configPath === undefined) {
    io.err(`Error: -c/--config is required for keys ${p.sub}`);
    return 1;
  }
  if (p.sub === "revoke" && p.id === undefined) {
    io.err("Error: keys revoke needs a key id (see `ai-gateway keys list`)");
    return 1;
  }

  let expiresAt: Date | undefined;
  if (p.expires !== undefined) {
    if (p.sub !== "create") {
      io.err("Error: --expires only applies to keys create");
      return 1;
    }
    expiresAt = new Date(p.expires);
    if (Number.isNaN(expiresAt.getTime())) {
      io.err(`Error: --expires "${p.expires}" is not an ISO date`);
      return 1;
    }
    if (expiresAt.getTime() <= Date.now()) {
      io.err(`Error: --expires ${expiresAt.toISOString()} is in the past`);
      return 1;
    }
  }

  // Validate the config the same way serve does, so the command runs against
  // the deployment it is pointed at. Its contents are never printed.
  try {
    loadConfigFromPath(p.configPath);
  } catch (err) {
    io.err(`Error: config ${p.configPath} is invalid:`);
    io.err((err instanceof Error ? err.message : String(err)).replace(/^/gm, "  "));
    return 1;
  }

  const dbPath = keyStorePath(resolveDataDir(p.dataDir));
  if (!existsSync(dbPath)) {
    io.err(
      `Error: no API key store at ${dbPath}. Point --data-dir (or GATEWAY_DATA_DIR) at the server's ` +
        "data directory, or start the gateway once to create it.",
    );
    return 1;
  }

  let store: KeyStore;
  try {
    store = await KeyStore.create(openKeyStoreDatabase(dbPath, { create: false }));
  } catch (err) {
    io.err(`Error: cannot open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    const now = new Date();
    if (p.sub === "list") {
      const keys = store.list();
      const latchedAt = store.bootstrapLatchedAt();
      if (p.json) {
        io.out(
          JSON.stringify(
            {
              keys: keys.map((k) => ({
                id: k.id,
                keyDisplay: k.keyDisplay,
                name: k.name,
                scopes: k.scopes,
                status: status(k, now),
                createdAt: iso(k.createdAt),
                expiresAt: iso(k.expiresAt),
                revokedAt: iso(k.revokedAt),
                lastUsedAt: iso(k.lastUsedAt),
                usageCount: k.usageCount,
              })),
              bootstrapLatchedAt: iso(latchedAt),
            },
            null,
            2,
          ),
        );
      } else {
        io.out(["ID", "KEY", "NAME", "SCOPES", "STATUS", "CREATED", "EXPIRES"].join("\t"));
        for (const k of keys) {
          io.out(
            [
              k.id,
              k.keyDisplay,
              k.name,
              k.scopes.join(","),
              status(k, now),
              k.createdAt.toISOString(),
              iso(k.expiresAt) ?? "-",
            ].join("\t"),
          );
        }
        io.err(
          `${keys.length} key(s) in ${dbPath}; bootstrap latch: ${
            latchedAt === null ? "not set (ADMIN_BOOTSTRAP_KEY accepted)" : `set at ${latchedAt.toISOString()}`
          }`,
        );
      }
      return 0;
    }

    if (p.sub === "revoke") {
      try {
        store.revoke(p.id!);
      } catch (err) {
        if (err instanceof KeyNotFoundError) {
          io.err(`Error: no key with id ${p.id}`);
          return 1;
        }
        throw err;
      }
      io.err(`Revoked key ${p.id}.`);
      return 0;
    }

    // create
    const scopes: string[] = [];
    if (p.admin) scopes.push(SCOPE_ADMIN);
    if (p.readOnly) scopes.push(SCOPE_READ_ONLY);
    if (scopes.length === 0) scopes.push(SCOPE_INFERENCE);
    const name = p.name ?? (p.admin ? "cli-admin" : p.readOnly ? "cli-read-only" : "cli-key");
    const created = store.create(name, scopes, expiresAt);
    if (p.json) {
      io.out(
        JSON.stringify({
          id: created.id,
          key: created.key,
          keyDisplay: created.keyDisplay,
          name: created.name,
          scopes: created.scopes,
          expiresAt: iso(created.expiresAt),
        }),
      );
    } else {
      io.out(created.key);
    }
    io.err(
      `Created key ${created.id} (${created.name}, scopes: ${created.scopes.join(",")}` +
        `${created.expiresAt ? `, expires ${created.expiresAt.toISOString()}` : ""}) in ${dbPath}. ` +
        "The secret was printed once on stdout; store it now, it cannot be shown again.",
    );
    return 0;
  } catch (err) {
    io.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    store.close();
  }
}
