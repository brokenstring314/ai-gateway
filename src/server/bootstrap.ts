/**
 * Server bootstrap shared by every way of running the gateway as a server.
 */

import type { Server } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Gateway } from "../gateway.js";
import { createApp, metricsPlacement, metricsResponse } from "../app.js";
import { createBootstrapGate } from "../auth/bootstrap.js";
import { loadConfigFromPath } from "../config/loader.js";
import type { GatewayConfig } from "../config/types.js";
import { KeyStore, keyStorePath, openKeyStoreDatabase, resolveDataDir } from "../persistence/key-store.js";
import { RequestLogStore, openRequestLogDatabase } from "../persistence/request-log-store.js";
import {
  parseAllowUnauthenticatedProxy,
  validateProductionSafety,
  isClientAuthEnabled,
  authExposureWarning,
} from "../config/production-safety.js";
import { ShutdownManager } from "./shutdown.js";
import { getRequestLogger, initRequestLogger } from "../observability/request-log.js";
import { initOtel } from "../observability/otel.js";
import { initOtelTracer } from "../observability/otel-tracer.js";
import { parseShutdownGrace } from "../observability/otel-policy.js";

export interface ServeOverrides {
  /** Overrides config.server.port (CLI -p). */
  port?: number;
  /** Overrides config.server.host (CLI -h). */
  host?: string;
  /** Data directory for the key and log stores (default: GATEWAY_DATA_DIR or .data). */
  dataDir?: string;
  /** Install SIGTERM/SIGINT/SIGHUP handlers (default true; tests pass false). */
  installSignalHandlers?: boolean;
}

/** A started gateway server (see bootstrap()). */
export interface RunningGateway {
  readonly server: Server<undefined>;
  /** Separate /metrics listener when observability.metrics.port ≠ the server port. */
  readonly metricsServer?: Server<undefined>;
  readonly gateway: Gateway;
  readonly config: GatewayConfig;
  readonly shutdown: ShutdownManager;
  /** Graceful stop: readiness 503, stop accepting, drain, close components. */
  stop(reason?: string): Promise<void>;
}

/**
 * The one server bootstrap: config file, stores (keys, logs),
 * production-safety checks, auth, OpenTelemetry, HTTP server and graceful
 * shutdown. `ai-gateway serve`, `bun src/index.ts serve` and embedders who
 * want the full server all go through here, so they enforce the same auth.
 *
 * Throws on an invalid config (the CLI prints it and exits 1).
 */
export async function bootstrap(configPath: string, overrides: ServeOverrides = {}): Promise<RunningGateway> {
  const config: GatewayConfig = loadConfigFromPath(configPath);

  const dataDir = resolveDataDir(overrides.dataDir);
  mkdirSync(dataDir, { recursive: true });

  // WAL + busy timeout: `ai-gateway keys ...` may write while the server runs.
  const keyDb = openKeyStoreDatabase(keyStorePath(dataDir));
  const logDb = openRequestLogDatabase(join(dataDir, "request-logs.sqlite"));

  let keyStore: KeyStore;
  let logStore: RequestLogStore;
  try {
    [keyStore, logStore] = await Promise.all([KeyStore.create(keyDb), RequestLogStore.create(logDb)]);
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

  // Fresh process-wide request logger (console JSON); the log store is
  // attached as a sink by createApp (logStore), so /admin/logs has data.
  initRequestLogger();
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
    shutdownGraceMs: parseShutdownGrace(config.observability?.tracing?.shutdownGrace),
    headers: config.observability?.tracing?.headers,
  });
  await initOtelTracer({
    enabled: config.observability?.tracing?.enabled,
    serviceName: config.observability?.tracing?.serviceName,
    privacyLevel: config.observability?.tracing?.privacyLevel,
  });
  shutdown.register({
    name: "otel",
    close: () => otelHandle.shutdown(),
  });
  const bootstrap = createBootstrapGate({
    bootstrapKey: process.env["ADMIN_BOOTSTRAP_KEY"],
    bootstrapReadOnlyKey: process.env["ADMIN_BOOTSTRAP_READ_ONLY_KEY"],
    keyStore,
    adminSecret: () => config.adminSecret,
    configKeys: () => config.auth?.keys,
  });
  // Logs "[auth] ... disabled: <reason>" now (once) if a real admin credential
  // exists, e.g. "permanently disabled: bootstrap latch is set ... remove them
  // from the environment" when ADMIN_BOOTSTRAP_KEY is still set after the
  // first admin key was created.
  bootstrap.disabledReason();
  const port = overrides.port ?? config.server?.port ?? 3000;
  const host = overrides.host ?? config.server?.host ?? "0.0.0.0";
  const metrics = metricsPlacement(config, port);
  const app = createApp(gateway, config, configPath, keyStore, {
    metrics,
    logStore,
    adminSecret: config.adminSecret,
    bootstrapKey: process.env["ADMIN_BOOTSTRAP_KEY"],
    bootstrapReadOnlyKey: process.env["ADMIN_BOOTSTRAP_READ_ONLY_KEY"],
    bootstrap,
    inFlightTracker: shutdown.inFlight,
  });

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

  // observability.metrics.port ≠ server port: /metrics on its own listener (no auth, metrics only).
  let metricsServer: Server<undefined> | undefined;
  if (metrics === "separate") {
    const metricsPort = config.observability?.metrics?.port;
    metricsServer = Bun.serve({
      port: metricsPort,
      hostname: host,
      fetch: (req) =>
        new URL(req.url).pathname === "/metrics" && req.method === "GET"
          ? metricsResponse()
          : new Response("Not Found", { status: 404 }),
    });
    console.log(`Metrics listening on http://${host}:${metricsServer.port}/metrics`);
  } else if (metrics === "off") {
    console.log("Metrics endpoint disabled (observability.metrics.enabled: false)");
  }

  // SIGTERM: readiness 503 -> stop accepting new connections (non-forced, so
  // in-flight streams can finish within the grace) -> drain -> force-close
  // whatever is left once the grace expires -> close components -> exit.
  shutdown.setStopAccepting(() => server.stop(false));
  shutdown.setForceClose(() => server.stop(true));
  // After the drain nothing should be left; a forced stop guarantees that a
  // non-forced stop() cannot wait on a hung connection (found by tests/e2e/ops.e2e.ts).
  shutdown.register({ name: "http", close: () => server.stop(true) });
  if (metricsServer) {
    const ms = metricsServer;
    shutdown.register({ name: "metrics-http", close: () => ms.stop(true) });
  }
  shutdown.register({ name: "gateway", close: () => gateway.close() });
  shutdown.register({ name: "request-logger", close: () => getRequestLogger().close() });
  shutdown.register({ name: "api-key-store", close: () => keyStore.close() });
  shutdown.register({ name: "request-log-store", close: () => logStore.close() });
  if (overrides.installSignalHandlers !== false) shutdown.installSignalHandlers();

  return {
    server,
    metricsServer,
    gateway,
    config,
    shutdown,
    stop: (reason = "stop() called") => shutdown.shutdown(reason),
  };
}

/**
 * Startup warnings about client credentials: the bootstrap admin key is live
 * because no real admin credential exists yet (it is refused automatically
 * once one does, see auth/bootstrap.ts), or auth is on but nothing can
 * authenticate yet.
 */
export function clientCredentialWarning(
  config: GatewayConfig,
  keyStore: Pick<KeyStore, "isEmpty" | "isBootstrapLatched">,
  bootstrapKey: string | undefined,
): string | undefined {
  const hasConfigKeys = (config.auth?.keys ?? []).some((k) => typeof k === "string" && k !== "");
  const hasAdminSecret = config.adminSecret !== undefined && config.adminSecret !== "";
  if (
    bootstrapKey !== undefined &&
    bootstrapKey !== "" &&
    !hasAdminSecret &&
    !hasConfigKeys &&
    !keyStore.isBootstrapLatched()
  ) {
    return (
      "WARNING: ADMIN_BOOTSTRAP_KEY is active because no admin credential exists yet " +
      "(no admin key has ever been created in the store, no adminSecret, no auth.keys). It is a full admin " +
      'credential until one exists, e.g. POST /admin/keys {"scopes": ["admin"]}; it is then refused ' +
      "permanently, even if that key is revoked later. Remove ADMIN_BOOTSTRAP_KEY from the environment afterwards."
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
