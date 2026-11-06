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
import { resolveRuntimeConfig } from "../config/runtime-source.js";
import type { ConfigStore } from "../persistence/config-store.js";
import type { GatewayConfig } from "../config/types.js";
import { KeyStore, keyStorePath, openKeyStoreDatabase, resolveDataDir } from "../persistence/key-store.js";
import { RequestLogStore, openRequestLogDatabase } from "../persistence/request-log-store.js";
import { KeyMeter } from "../usage/key-meter.js";
import { UsageRecorder } from "../usage/recorder.js";
import { openUsageDatabase, UsageStore, usageStorePath } from "../usage/usage-store.js";
import {
  parseAllowUnauthenticatedProxy,
  validateProductionSafety,
  isClientAuthEnabled,
  authExposureWarning,
} from "../config/production-safety.js";
import { PublicHostGuard, type HostResolver } from "../security/url-guard.js";
import { ShutdownManager } from "./shutdown.js";
import { getRequestLogger, initRequestLogger } from "../observability/request-log.js";
import { initOtel } from "../observability/otel.js";
import { initOtelTracer } from "../observability/otel-tracer.js";
import { parseShutdownGrace } from "../observability/otel-policy.js";
import { publishedModelNameProblem } from "../core/request-limits.js";

export interface ServeOverrides {
  /** Overrides config.server.port (CLI -p). */
  port?: number;
  /** Overrides config.server.host (CLI -h). */
  host?: string;
  /** Data directory for the key and log stores (default: GATEWAY_DATA_DIR or .data). */
  dataDir?: string;
  /** Install SIGTERM/SIGINT/SIGHUP handlers (default true; tests pass false). */
  installSignalHandlers?: boolean;
  /**
   * DNS resolver behind the SSRF guard of Admin API channels (embedders and
   * test harnesses only: the browser e2e suite maps its fake upstream host
   * names to a public address). Not reachable from the CLI, the config file
   * or the environment; the guard's address rules are unchanged.
   */
  hostResolver?: HostResolver;
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
  const fileConfig: GatewayConfig = loadConfigFromPath(configPath);

  const dataDir = resolveDataDir(overrides.dataDir);
  mkdirSync(dataDir, { recursive: true });

  // Runtime sections from the config store (imported from the file on first
  // start) unless runtimeConfig.source: file. Throws on a missing/wrong
  // GATEWAY_SECRET_KEY or a failed migration: never start half-configured.
  const runtime = await resolveRuntimeConfig(fileConfig, dataDir, { configPath });
  // Audit log retention (FA-3): pruned in the background, never on the request path.
  runtime.store?.startAuditRetention(fileConfig.audit ?? {});
  const config: GatewayConfig = runtime.config;

  // WAL + busy timeout: `ai-gateway keys ...` may write while the server runs.
  const keyDb = openKeyStoreDatabase(keyStorePath(dataDir));
  const logDb = openRequestLogDatabase(join(dataDir, "request-logs.sqlite"));
  const usageDb = openUsageDatabase(usageStorePath(dataDir));

  let keyStore: KeyStore;
  let logStore: RequestLogStore;
  let usageStore: UsageStore;
  try {
    [keyStore, logStore, usageStore] = await Promise.all([
      KeyStore.create(keyDb),
      RequestLogStore.create(logDb),
      UsageStore.create(usageDb),
    ]);
  } catch (err) {
    keyDb.close();
    logDb.close();
    usageDb.close();
    runtime.store?.close();
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
  // Production refuses < 16 characters; elsewhere a short secret is only a
  // warning. The header lockout (P4) slows guessing but cannot save a weak one.
  if (
    config.adminSecret !== undefined &&
    config.adminSecret.length < 16 &&
    process.env["GATEWAY_ENV"] !== "production"
  ) {
    console.warn(
      `[config] adminSecret is ${config.adminSecret.length} characters; use at least 16 (32+ random characters ` +
        "recommended, e.g. `openssl rand -base64 32`). GATEWAY_ENV=production refuses shorter ones.",
    );
  }

  // Fresh process-wide request logger (console JSON); the log store is
  // attached as a sink by createApp (logStore), so /admin/logs has data.
  initRequestLogger();
  // Per-key quota / RPM / TPM counters: restored from the key store, kept for the
  // process's life (reloads included), persisted asynchronously by the recorder.
  const keyMeter = new KeyMeter();
  keyMeter.restore(keyStore.usedTokensByKey());
  const gateway = new Gateway(config, {
    keyMeter,
    ...(overrides.hostResolver ? { publicHostGuard: new PublicHostGuard(overrides.hostResolver) } : {}),
  });
  const usageRecorder = new UsageRecorder({
    store: usageStore,
    meter: keyMeter,
    keyStore,
    intervalMs: parseEnvNumber(process.env["USAGE_FLUSH_INTERVAL_MS"]) ?? 1000,
  });
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
  if (runtime.store) persistKeyHealth(gateway, runtime.store);
  const app = createApp(gateway, config, configPath, keyStore, {
    metrics,
    logStore,
    usageStore,
    usageRecorder,
    ...(runtime.store ? { configStore: runtime.store } : {}),
    configApi: {
      backups: { keep: 5, minIntervalMs: parseEnvNumber(process.env["CONFIG_BACKUP_MIN_INTERVAL_MS"]) ?? 0 },
      ...(overrides.hostResolver ? { resolver: overrides.hostResolver } : {}),
    },
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
  console.log(`Runtime config: ${runtime.source === "file" ? "config file (read-only)" : "config store"}`);
  console.log(`Strategy: ${config.strategy.mode}`);
  for (const warning of publishedModelWarnings(gateway, config)) console.warn(warning);
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
  // Last usage flush (rollups + used tokens) before the stores close.
  shutdown.register({ name: "usage-recorder", close: () => usageRecorder.close() });
  shutdown.register({ name: "api-key-store", close: () => keyStore.close() });
  shutdown.register({ name: "usage-store", close: () => usageStore.close() });
  shutdown.register({ name: "request-log-store", close: () => logStore.close() });
  const configStore = runtime.store;
  if (configStore) shutdown.register({ name: "config-store", close: () => configStore.close() });
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
 * Upstream key health → config store, asynchronously (the request path
 * never waits on the database): a key disabled after a 401 (or repeated
 * account-level 402s) is recorded (status, last error, audit row) and stays
 * out of later runtime builds; a 429 / 402 cooldown is in memory only and
 * just logged.
 */
export function persistKeyHealth(gateway: Gateway, store: ConfigStore): () => void {
  return gateway.onKeyEvent((e) => {
    if (e.kind === "cooldown") {
      console.warn(
        e.httpStatus === 402
          ? `[keys] channel "${e.channel}" key ${e.keyId} got upstream 402 (payment required); cooling down for ${e.seconds}s`
          : `[keys] channel "${e.channel}" key ${e.keyId} rate limited upstream; cooling down for ${e.seconds}s`,
      );
      return;
    }
    console.warn(
      `[keys] channel "${e.channel}" key ${e.keyId} disabled after upstream ${e.httpStatus} (${e.status}): ${e.error}`,
    );
    setTimeout(() => {
      try {
        store.recordKeyDisabled({
          keyId: e.keyId,
          status: e.status,
          error: e.error,
          at: e.at,
          httpStatus: e.httpStatus,
        });
      } catch (err) {
        console.error(
          `[keys] could not persist the disabled key ${e.keyId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, 0);
  });
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

/** Startup hints when published models leave targets idle or publish nothing (0.3.0: unknown models are rejected). */
export function publishedModelWarnings(gateway: Gateway, config: GatewayConfig): string[] {
  const catalog = gateway.modelCatalog();
  const out: string[] = [];
  if (catalog.list().length === 0) {
    out.push(
      "[models] no models are published, so every model request is rejected (404 model_not_found). " +
        (catalog.explicit
          ? "Add entries to models:."
          : "List each target's models in targets[].models, or add a models: section."),
    );
    return out;
  }
  // Names saved before the Admin API checked them (B7) still load; say which ones clients may fail to send.
  for (const m of catalog.list()) {
    const problem = publishedModelNameProblem(m.name);
    if (problem !== undefined) {
      out.push(
        `[models] published model ${JSON.stringify(m.name.slice(0, 80))} has an invalid name: ${problem} ` +
          "It is still served; rename it in the console (models → edit).",
      );
    }
    if (m.enabled && m.targets.length === 0) {
      out.push(
        `[models] published model ${JSON.stringify(m.name.slice(0, 80))} is enabled but has no usable binding (none, or all disabled / on disabled channels): ` +
          "requests for it get 503 model_unavailable. Bind a channel or disable it.",
      );
    }
  }
  const unused = catalog.unusedTargets(config.targets.map((t) => t.name));
  if (unused.length > 0) {
    out.push(
      `[models] target(s) ${unused.join(", ")} serve no published model and get no requests: ` +
        (catalog.explicit ? "bind them in models[].bindings." : "list their models in targets[].models."),
    );
  }
  return out;
}
