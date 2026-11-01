/**
 * Resolve the effective config at startup (0.3.0, plan §3.1).
 *
 * Startup sections (server, auth, CORS, observability, MCP, …) always come
 * from the config file. The runtime sections (targets, strategy, aliases,
 * plugins, compatibility) come from:
 *  - runtimeConfig.source: "database" (default): <dataDir>/config.sqlite.
 *    On first start the file's runtime sections are imported once; after
 *    that the store is the source of truth and a changed file only earns a
 *    warning (`ai-gateway config import --force` re-imports it).
 *  - runtimeConfig.source: "file": the file, as in 0.2.0 (read-only).
 *
 * The composed config is re-validated with the same strict schema as the file.
 */

import { mkdirSync } from "node:fs";
import { z } from "zod";
import {
  ConfigStore,
  ConfigStoreError,
  configStorePath,
  openConfigDatabase,
  RUNTIME_SECTIONS,
  runtimeSectionsHash,
} from "../persistence/config-store.js";
import { SECRET_KEY_HELP, SecretBox } from "../secrets/secret-box.js";
import { GatewayConfigSchema } from "./schema.js";
import type { GatewayConfig } from "./types.js";

export type RuntimeSource = "database" | "file";

export interface ResolvedRuntimeConfig {
  readonly config: GatewayConfig;
  readonly source: RuntimeSource;
  /** The store (database source only); the caller closes it on shutdown. */
  readonly store?: ConfigStore;
  /** True when this start imported the file into an empty store. */
  readonly imported: boolean;
}

export function runtimeSourceOf(config: GatewayConfig): RuntimeSource {
  return config.runtimeConfig?.source ?? "database";
}

/** Open the store for `dataDir` (backup + migrations). */
export async function openConfigStore(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ConfigStore> {
  const box = await SecretBox.fromEnv(env);
  mkdirSync(dataDir, { recursive: true });
  const path = configStorePath(dataDir);
  const db = openConfigDatabase(path);
  try {
    return await ConfigStore.create(db, box, path);
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Startup sections from `file` + runtime sections from `runtime`, validated. */
export function composeConfig(file: GatewayConfig, runtime: Partial<GatewayConfig>): GatewayConfig {
  const merged: Record<string, unknown> = { ...file };
  for (const key of RUNTIME_SECTIONS) delete merged[key];
  Object.assign(merged, runtime);
  const result = GatewayConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigStoreError(`stored runtime config is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data as GatewayConfig;
}

export async function resolveRuntimeConfig(
  file: GatewayConfig,
  dataDir: string,
  opts: { configPath?: string; env?: Record<string, string | undefined> } = {},
): Promise<ResolvedRuntimeConfig> {
  const env = opts.env ?? process.env;
  const source = runtimeSourceOf(file);
  if (source === "file") return { config: file, source, imported: false };

  if (env["GATEWAY_ENV"] === "production" && !(env["GATEWAY_SECRET_KEY"] ?? "").trim()) {
    throw new ConfigStoreError(
      "GATEWAY_ENV=production with runtimeConfig.source: database requires GATEWAY_SECRET_KEY " +
        `(upstream keys are encrypted at rest). ${SECRET_KEY_HELP}`,
    );
  }

  const store = await openConfigStore(dataDir, env);
  try {
    let imported = false;
    if (!store.isInitialized()) {
      const v = await store.importFromConfig(file);
      imported = true;
      console.log(
        `[config] imported ${file.targets.length} target(s) and routing settings from ${opts.configPath ?? "the config file"} ` +
          `into ${configStorePath(dataDir)} (config version ${v.version}). From now on the stored config is used; ` +
          "the file's targets/strategy/aliases/plugins/compatibility are ignored.",
      );
    } else if ((await runtimeSectionsHash(file)) !== store.getMeta("yaml_runtime_hash")) {
      console.warn(
        `[config] the runtime sections of ${opts.configPath ?? "the config file"} (targets, strategy, aliases, plugins, ` +
          `compatibility) changed since they were imported and are IGNORED: the stored config in ${configStorePath(dataDir)} ` +
          `is used. To replace it with the file: ai-gateway config import --force -c ${opts.configPath ?? "<config.yaml>"} ` +
          "(or set runtimeConfig.source: file).",
      );
    }
    const config = composeConfig(file, await store.loadRuntimeSections());
    return { config, source, store, imported };
  } catch (err) {
    store.close();
    throw err;
  }
}
