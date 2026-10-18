/**
 * AI Gateway Rewrite — TypeScript + Hono
 * Entry point for embedded mode and CLI.
 */

import { Gateway } from "./gateway.js";
import { createApp } from "./app.js";
import { createBootstrapGate } from "./auth/bootstrap.js";
import { loadConfigFromPath } from "./config/loader.js";
import { safeParseConfig } from "./config/schema.js";
import type { GatewayConfig } from "./config/types.js";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { KeyStore } from "./persistence/key-store.js";
import { RequestLogStore } from "./persistence/request-log-store.js";
import {
  parseAllowUnauthenticatedProxy,
  validateProductionSafety,
  isClientAuthEnabled,
  authExposureWarning,
} from "./config/production-safety.js";
import { ShutdownManager } from "./server/shutdown.js";
import { getRequestLogger } from "./observability/request-log.js";
import { initOtel } from "./observability/otel.js";
import { initOtelTracer } from "./observability/otel-tracer.js";
import { parseShutdownGrace } from "./observability/otel-policy.js";

const VERSION = "1.0.0";

// ── Embedded mode exports ──

export { Gateway } from "./gateway.js";
export { createApp } from "./app.js";
export { loadConfigFromPath, loadConfigFromObject } from "./config/loader.js";
export { parseConfig, safeParseConfig } from "./config/schema.js";
export type * from "./providers/types.js";
export type * from "./routing/types.js";
export type * from "./plugins/types.js";
export type * from "./config/types.js";

// ── CLI mode ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    process.exit(0);
  }

  if (subcommand === "version" || subcommand === "--version" || subcommand === "-v") {
    console.log(`ai-gateway v${VERSION}`);
    process.exit(0);
  }

  if (subcommand === "validate") {
    const configPath = findConfigPath(args.slice(1));
    if (!configPath) {
      console.error("Error: config path required. Usage: ai-gateway validate -c <config.yaml>");
      process.exit(1);
    }
    await validateConfig(configPath);
    return;
  }

  if (subcommand === "serve") {
    const configPath = findConfigPath(args.slice(1));
    if (!configPath) {
      console.error("Error: config path required. Usage: ai-gateway serve -c <config.yaml>");
      process.exit(1);
    }
    await serve(configPath);
    return;
  }

  console.error(`Unknown command: ${subcommand}`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`ai-gateway v${VERSION} — OpenAI-compatible AI gateway`);
  console.log("");
  console.log("Commands:");
  console.log("  serve     Start the gateway server (default)");
  console.log("  validate  Validate a config file");
  console.log("  version   Print version information");
  console.log("");
  console.log("Usage:");
  console.log("  ai-gateway serve -c <config.yaml>");
  console.log("  ai-gateway serve --config <config.yaml>");
  console.log("  ai-gateway validate -c <config.yaml>");
  console.log("  ai-gateway version");
}

function findConfigPath(args: string[]): string | undefined {
  const shortIdx = args.indexOf("-c");
  if (shortIdx !== -1 && args[shortIdx + 1]) return args[shortIdx + 1];
  const longIdx = args.indexOf("--config");
  if (longIdx !== -1 && args[longIdx + 1]) return args[longIdx + 1];
  return undefined;
}

async function validateConfig(configPath: string): Promise<void> {
  try {
    const raw = await import("fs").then((fs) => fs.readFileSync(configPath, "utf-8"));
    const yaml = await import("yaml");
    const parsed = yaml.parse(raw);
    const result = safeParseConfig(parsed);

    if (result.success) {
      const config = result.data as GatewayConfig;
      console.log("✓ Config is valid");
      console.log(`  Strategy: ${config.strategy.mode}`);
      console.log(`  Targets: ${config.targets.map((t) => t.name).join(", ")}`);
      console.log(`  Models: ${config.targets.flatMap((t) => t.models).join(", ")}`);
      console.log(`  Auth: ${isClientAuthEnabled(config.auth) ? "enabled" : "disabled"}`);
      process.exit(0);
    } else {
      console.error("✗ Config validation failed:");
      for (const issue of result.error.issues) {
        console.error(`  ${issue.path.join(".")}: ${issue.message}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(`✗ Failed to load config from ${configPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export interface ServeOverrides {
  /** Overrides config.server.port (CLI -p). */
  port?: number;
  /** Overrides config.server.host (CLI -h). */
  host?: string;
}

/**
 * Full server bootstrap: config file, stores (keys, logs), production-safety checks, auth, observability and
 * graceful shutdown. Both `bun src/index.ts serve` and the `ai-gateway serve`
 * CLI (src/cli/index.ts) go through here so they enforce the same auth.
 */
export async function serve(configPath: string, overrides: ServeOverrides = {}): Promise<void> {
  let config: GatewayConfig;
  try {
    config = loadConfigFromPath(configPath);
  } catch (err) {
    console.error(`Failed to load config from ${configPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const dataDir = process.env["GATEWAY_DATA_DIR"] ?? ".data";
  mkdirSync(dataDir, { recursive: true });

  const keyDb = new Database(join(dataDir, "api-keys.sqlite"));
  const logDb = new Database(join(dataDir, "request-logs.sqlite"));

  let keyStore: KeyStore;
  let logStore: RequestLogStore;
  try {
    [keyStore, logStore] = await Promise.all([
      KeyStore.create(keyDb),
      RequestLogStore.create(logDb),
    ]);
  } catch (err) {
    keyDb.close();
    logDb.close();
    throw err;
  }

  // Before 0.2.0 a config saved via PUT /admin/config was persisted here and
  // silently replaced the config file at startup. The file is now the only
  // source of truth; say so once if an old database is still around.
  const legacyConfigDb = join(dataDir, "gateway-config.sqlite");
  if (existsSync(legacyConfigDb)) {
    console.warn(
      `[config] ignoring ${legacyConfigDb}: persisted runtime config was removed in 0.2.0; ` +
        `using ${configPath}. Delete the file to silence this warning.`,
    );
  }

  validateProductionSafety({
    gatewayEnv: process.env["GATEWAY_ENV"],
    allowUnauthenticatedProxy: parseAllowUnauthenticatedProxy(),
    adminSecret: config.adminSecret,
    authEnabled: config.auth?.enabled,
    // config.auth.keys are accepted by authMiddleware, so they count here.
    hasAuthKeys: (config.auth?.keys ?? []).some((k) => typeof k === "string" && k !== ""),
    keyStoreEmpty: keyStore.isEmpty(),
  });

  const gateway = new Gateway(config);
  await gateway.initMcp();
  const shutdown = new ShutdownManager({
    shutdownGraceMs: parseEnvNumber(process.env["SHUTDOWN_GRACE_MS"]) ?? 10_000,
    logger: (message) => console.log(`[shutdown] ${message}`),
  });

  const otelHandle = await initOtel({
    enabled: config.observability?.tracing?.enabled,
    otlpEndpoint: config.observability?.tracing?.otlpEndpoint,
    serviceName: config.observability?.tracing?.serviceName,
    sampleRatio: config.observability?.tracing?.sampleRatio,
    privacyLevel: config.observability?.tracing?.privacyLevel,
    shutdownGraceMs: parseShutdownGrace(
      config.observability?.tracing?.shutdownGrace,
    ),
    headers: config.observability?.tracing?.headers,
  });
  await initOtelTracer({
    enabled: config.observability?.tracing?.enabled,
    serviceName: config.observability?.tracing?.serviceName,
    privacyLevel: config.observability?.tracing?.privacyLevel,
  });
  const { resolveEnabledExporters } = await import("./observability/exporter-registry.js");
  const exporterConfigs = (config.observability?.exporters ?? []).map((entry) => ({
    name: entry.name,
    enabled: entry.enabled !== false,
    config: entry.config ?? {},
  }));
  const { exporters, skipped } = resolveEnabledExporters(exporterConfigs);
  for (const name of skipped) {
    console.warn(`[observability] exporter "${name}" unavailable; skipping`);
  }
  for (const exporter of exporters) {
    console.log(`[observability] exporter "${exporter.name}" initialized`);
  }
  shutdown.register({
    name: "otel",
    close: async () => {
      for (const exporter of exporters) {
        try {
          await exporter.shutdown();
        } catch {
          // best-effort: never let an exporter stall shutdown
        }
      }
      await otelHandle.shutdown();
    },
  });
  const bootstrap = createBootstrapGate({
    bootstrapKey: process.env["ADMIN_BOOTSTRAP_KEY"],
    bootstrapReadOnlyKey: process.env["ADMIN_BOOTSTRAP_READ_ONLY_KEY"],
    keyStore,
    adminSecret: () => config.adminSecret,
    configKeys: () => config.auth?.keys,
  });
  // Logs "[auth] ... disabled: <reason>" now if a real admin credential exists.
  bootstrap.disabledReason();
  const app = createApp(gateway, config, configPath, keyStore, {
    logStore,
    adminSecret: config.adminSecret,
    bootstrapKey: process.env["ADMIN_BOOTSTRAP_KEY"],
    bootstrapReadOnlyKey: process.env["ADMIN_BOOTSTRAP_READ_ONLY_KEY"],
    bootstrap,
    inFlightTracker: shutdown.inFlight,
  });

  const port = overrides.port ?? config.server?.port ?? 3000;
  const host = overrides.host ?? config.server?.host ?? "0.0.0.0";

  console.log(`AI Gateway starting on ${host}:${port}`);
  const exposureWarning = authExposureWarning(config.auth, host);
  if (exposureWarning) {
    console.warn("!".repeat(80));
    console.warn(exposureWarning);
    console.warn("!".repeat(80));
  }
  const credentialWarning = clientCredentialWarning(config, keyStore, process.env["ADMIN_BOOTSTRAP_KEY"]);
  if (credentialWarning) {
    console.warn("!".repeat(80));
    console.warn(credentialWarning);
    console.warn("!".repeat(80));
  }
  console.log(`Strategy: ${config.strategy.mode}`);
  console.log(`Targets: ${config.targets.map((t) => t.name).join(", ")}`);

  const server = Bun.serve({
    port,
    hostname: host,
    // Bun's default idleTimeout (10s) cuts SSE streams and slow non-streaming
    // completions whenever upstream is silent for 10s; streams additionally
    // send `: ping` heartbeats (server.sseHeartbeatSeconds).
    idleTimeout: resolveIdleTimeout(config.server?.idleTimeoutSeconds),
    fetch: app.fetch,
  });

  console.log(`AI Gateway listening on http://${host}:${port}`);

  shutdown.register({ name: "http", close: () => server.stop() });
  shutdown.register({ name: "gateway", close: () => gateway.close() });
  shutdown.register({ name: "request-logger", close: () => getRequestLogger().close() });
  shutdown.register({ name: "api-key-store", close: () => keyStore.close() });
  shutdown.register({ name: "request-log-store", close: () => logStore.close() });
  shutdown.installSignalHandlers();
}

/**
 * Startup warnings about client credentials: the bootstrap admin key is live
 * because no real admin credential exists yet (it is refused automatically
 * once one does, see auth/bootstrap.ts), or auth is on but nothing can
 * authenticate yet.
 */
export function clientCredentialWarning(
  config: GatewayConfig,
  keyStore: Pick<KeyStore, "isEmpty" | "hasActiveAdminKey">,
  bootstrapKey: string | undefined,
): string | undefined {
  const hasConfigKeys = (config.auth?.keys ?? []).some((k) => typeof k === "string" && k !== "");
  const hasAdminSecret = config.adminSecret !== undefined && config.adminSecret !== "";
  if (
    bootstrapKey !== undefined && bootstrapKey !== "" &&
    !hasAdminSecret && !hasConfigKeys && !keyStore.hasActiveAdminKey()
  ) {
    return (
      "WARNING: ADMIN_BOOTSTRAP_KEY is active because no admin credential exists yet " +
      "(no admin key in the store, no adminSecret, no auth.keys). It is a full admin credential until " +
      'one exists, e.g. POST /admin/keys {"scopes": ["admin"]}; it is then refused automatically. ' +
      "Remove ADMIN_BOOTSTRAP_KEY from the environment afterwards."
    );
  }
  if (!isClientAuthEnabled(config.auth) || !keyStore.isEmpty()) return undefined;
  if (!hasConfigKeys) {
    return (
      "WARNING: client auth is enabled but no client keys exist (no auth.keys, empty key store): " +
      "every /v1/* request will be rejected with 401 until a key is created via the admin API."
    );
  }
  return undefined;
}

/** Bun.serve idleTimeout in seconds: configured value clamped to 0..255, default 255 (Bun's max). */
export function resolveIdleTimeout(configured: number | undefined): number {
  if (configured === undefined || !Number.isFinite(configured)) return 255;
  return Math.min(255, Math.max(0, Math.floor(configured)));
}

function parseEnvNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Run CLI only when this file is the entry point (not when imported, e.g. by
// src/cli/index.ts, whose path also ends in index.ts).
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
