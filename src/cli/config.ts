/**
 * `ai-gateway config ...` — the runtime config store (<data dir>/config.sqlite).
 *
 *   ai-gateway config import [--force] [--data-dir D] -c <config>
 *       Import the file's targets/strategy/aliases/plugins/compatibility into
 *       the store. Refuses when the store already holds config unless --force
 *       (which replaces it, recorded as a new config version).
 *   ai-gateway config status [--json] [--data-dir D] -c <config>
 *       Source, channels (key hints only, never values) and recent versions.
 *
 * A running server picks up an import on its next start.
 */

import { existsSync } from "node:fs";
import { loadConfigFromPath } from "../config/loader.js";
import { openConfigStore, runtimeSourceOf } from "../config/runtime-source.js";
import { configStorePath } from "../persistence/config-store.js";
import { resolveDataDir } from "../persistence/key-store.js";

export interface ConfigCliIO {
  out(line: string): void;
  err(line: string): void;
}

const defaultIO: ConfigCliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = `Usage:
  ai-gateway config import [--force] [--data-dir <dir>] -c <config.yaml>
  ai-gateway config status [--json] [--data-dir <dir>] -c <config.yaml>`;

interface Parsed {
  sub?: string;
  configPath?: string;
  dataDir?: string;
  force: boolean;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseConfigArgs(args: readonly string[]): Parsed {
  const p: Parsed = { force: false, json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" || a === "--config" || a === "--data-dir") {
      const v = args[++i];
      if (v === undefined || v.startsWith("-")) p.error ??= `${a} needs a value`;
      else if (a === "--data-dir") p.dataDir = v;
      else p.configPath = v;
    } else if (a === "--force") p.force = true;
    else if (a === "--json") p.json = true;
    else if (a === "--help" || a === "-h") p.help = true;
    else if (!a.startsWith("-") && p.sub === undefined) p.sub = a;
    else p.error ??= `unexpected argument "${a}"`;
  }
  return p;
}

export async function configCommand(args: readonly string[], io: ConfigCliIO = defaultIO): Promise<number> {
  const p = parseConfigArgs(args);
  if (p.help) {
    io.out(USAGE);
    return 0;
  }
  if (p.error || (p.sub !== "import" && p.sub !== "status") || !p.configPath) {
    io.err(p.error ? `Error: ${p.error}` : !p.configPath && p.sub ? "Error: -c/--config is required" : USAGE);
    if (p.error) io.err(USAGE);
    return 1;
  }
  if (!existsSync(p.configPath)) {
    io.err(`Error: config file not found: ${p.configPath}`);
    return 1;
  }

  let store: Awaited<ReturnType<typeof openConfigStore>> | undefined;
  try {
    const file = loadConfigFromPath(p.configPath);
    const dataDir = resolveDataDir(p.dataDir);
    if (p.sub === "import" && runtimeSourceOf(file) === "file") {
      io.err('Error: runtimeConfig.source is "file": the gateway reads the file directly; nothing to import.');
      return 1;
    }
    if (p.sub === "status" && !existsSync(configStorePath(dataDir))) {
      io.out(`source: ${runtimeSourceOf(file)}\nstore: ${configStorePath(dataDir)} (not created yet)`);
      return 0;
    }
    store = await openConfigStore(dataDir);

    if (p.sub === "import") {
      if (store.isInitialized() && !p.force) {
        const latest = store.listVersions(1)[0];
        io.err(
          `Error: ${configStorePath(dataDir)} already holds runtime config (version ${latest?.version ?? "?"}). ` +
            "Pass --force to replace it with the file's targets/strategy/aliases/plugins/compatibility.",
        );
        return 1;
      }
      const v = await store.importFromConfig(file, { actor: "cli:config-import" });
      io.out(`Imported ${file.targets.length} target(s) as config version ${v.version}. Restart the gateway to apply.`);
      return 0;
    }

    const channels = store.listChannels();
    const versions = store.listVersions(5);
    if (p.json) {
      io.out(
        JSON.stringify({ source: runtimeSourceOf(file), store: configStorePath(dataDir), channels, versions }, null, 2),
      );
      return 0;
    }
    io.out(`source: ${runtimeSourceOf(file)}`);
    io.out(`store:  ${configStorePath(dataDir)}`);
    io.out("channels:");
    for (const c of channels) {
      const keys = c.keys.map((k) => `${k.hint}${k.status !== "ok" ? ` (${k.status})` : ""}`).join(", ") || "no key";
      io.out(`  ${c.enabled ? "●" : "○"} ${c.name}  ${c.preset}  ${c.baseURL ?? ""}  keys: ${keys}`);
    }
    io.out("versions:");
    for (const v of versions) io.out(`  #${v.version}  ${v.createdAt}  ${v.actor ?? ""}  ${v.summary}`);
    return 0;
  } catch (err) {
    io.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    store?.close();
  }
}
