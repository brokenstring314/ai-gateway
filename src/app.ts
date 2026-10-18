/**
 * Hono app factory — wires all middleware and handlers into a Hono instance.
 *
 * Middleware order (outermost first):
 *   1. recover        — catch-all panic recovery
 *   2. body-limit     — reject oversized request bodies
 *   3. security-headers — add security headers to all responses
 *   4. cors           — CORS headers
 *   5. auth           — Bearer token authentication
 *   6. request-timeout — AbortController-based timeout
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { respondError } from "./handlers/error-response.js";
import type { Gateway } from "./gateway.js";
import type { GatewayConfig } from "./config/types.js";
import { recoverMiddleware } from "./middleware/recover.js";
import { bodyLimitMiddleware } from "./middleware/body-limit.js";
import { securityHeadersMiddleware } from "./middleware/security-headers.js";
import { corsMiddleware } from "./middleware/cors.js";
import { authMiddleware } from "./middleware/auth.js";
import { getNormalizedPath } from "./server/route-path.js";
import { PluginRejectionError } from "./plugins/error.js";
import { isClientAuthEnabled } from "./config/production-safety.js";
import { createBootstrapGate, type BootstrapGate } from "./auth/bootstrap.js";
import type { KeyStore } from "./persistence/key-store.js";
import { perIpRateLimitMiddleware, requestRemoteAddress } from "./middleware/per-ip-rate-limit.js";
import { parseTrustedProxies, resolveClientIp } from "./middleware/trusted-proxy.js";
import { requestTimeoutMiddleware } from "./middleware/request-timeout.js";
import { registerChatHandler } from "./handlers/chat.js";
import { registerCompletionsHandler } from "./handlers/completions.js";
import { registerEmbeddingsHandler } from "./handlers/embeddings.js";
import { registerImagesHandler } from "./handlers/images.js";
import { registerModelsHandler } from "./handlers/models.js";
import { registerHealthHandler, registerLivenessHandler, registerReadinessHandler } from "./handlers/health.js";
import { registerCapabilitiesHandler } from "./handlers/capabilities.js";
import { createAdminApp, type AdminAppOptions } from "./admin/handlers.js";
import { createDashboardApp } from "./dashboard/index.js";
import { createProxyHandler, createProxyKeyValidator, resolveProxyTarget } from "./proxy/proxy.js";
import {
  compileRouteAllowlist,
  DEFAULT_PASSTHROUGH_ROUTES,
  GATEWAY_ROUTE_METHODS,
} from "./core/surfaces/passthrough.js";
import { resolveBaseURL } from "./core/provider-presets.js";
import { expandTargetEnvRefs } from "./config/envref.js";
import { getMetrics as getPrometheusMetrics } from "./metrics/metrics.js";
import type { InFlightTracker } from "./server/shutdown.js";
import { requestLogStoreSink } from "./observability/request-log.js";

/** Shared Hono environment type for all handlers and middleware. */
export type AppEnv = {
  Variables: {
    apiKey: string | undefined;
    abortController: AbortController;
  };
};

export type AppType = Hono<AppEnv>;

export interface CreateAppOptions extends AdminAppOptions {
  bootstrapKey?: string;
  bootstrapReadOnlyKey?: string;
  inFlightTracker?: InFlightTracker;
  /** Where GET /metrics is served (default: metricsPlacement(config, config.server.port)). */
  metrics?: MetricsPlacement;
}

export type MetricsPlacement = "main" | "separate" | "off";

/**
 * Where /metrics is served, from observability.metrics:
 *  - no `metrics` block: on the main port (pre-0.2 behavior);
 *  - enabled: false → not served;
 *  - enabled: true and port = the server port → main port;
 *  - enabled: true and another port → its own listener (bootstrap starts it).
 */
export function metricsPlacement(config: GatewayConfig, serverPort: number): MetricsPlacement {
  const m = config.observability?.metrics;
  if (m === undefined) return "main";
  if (m.enabled !== true) return "off";
  return m.port === undefined || m.port === serverPort ? "main" : "separate";
}

/** GET /metrics handler body (Prometheus text format). */
export async function metricsResponse(): Promise<Response> {
  const text = await getPrometheusMetrics().format();
  return new Response(text, { status: 200, headers: { "Content-Type": "text/plain; version=0.0.4" } });
}

/** Probe endpoints that keep answering while the server drains. */
const DRAIN_EXEMPT_PATHS: ReadonlySet<string> = new Set(["/health", "/livez", "/readyz", "/metrics"]);

export function createApp(
  gateway: Gateway,
  config: GatewayConfig,
  configPath?: string,
  keyStore?: KeyStore,
  options?: Omit<CreateAppOptions, "keyStore">,
): AppType {
  const app: AppType = new Hono<AppEnv>({ getPath: getNormalizedPath });

  // One gate for every route: bootstrap keys stop working as soon as a real
  // admin credential exists (store admin key, adminSecret or auth.keys).
  const bootstrap: BootstrapGate =
    options?.bootstrap ??
    createBootstrapGate({
      bootstrapKey: options?.bootstrapKey,
      bootstrapReadOnlyKey: options?.bootstrapReadOnlyKey,
      keyStore,
      adminSecret: () => options?.adminSecret ?? config.adminSecret,
      configKeys: () => config.auth?.keys,
    });

  // Every finalized request is also written to the log store (/admin/logs, dashboard).
  if (options?.logStore) gateway.addRequestLogSink(requestLogStoreSink(options.logStore));

  // ── Middleware (order matters) ──
  app.use("*", recoverMiddleware());
  app.use("*", bodyLimitMiddleware(config.maxRequestBytes));
  app.use("*", securityHeadersMiddleware());
  app.use("*", corsMiddleware(config.cors?.origins, { allowHeaders: config.cors?.allowHeaders }));

  const metrics = getPrometheusMetrics();
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    await next();
    const labels = {
      method: c.req.method,
      status: c.res.status,
      provider: c.res.headers.get("X-Gateway-Provider") ?? "unknown",
    };
    metrics.recordRequest(labels);
    metrics.observeDuration((performance.now() - startedAt) / 1000, labels);
  });

  if (options?.inFlightTracker) {
    const tracker = options.inFlightTracker;
    app.use("*", async (c, next) => {
      // Draining after SIGTERM: probes still answer (readyz says 503), new
      // work is refused so the in-flight count can reach zero.
      if (tracker.draining && !DRAIN_EXEMPT_PATHS.has(c.req.path)) {
        c.header("Connection", "close");
        c.header("Retry-After", "1");
        return c.json(
          { error: { message: "Server is shutting down", type: "unavailable", code: "shutting_down" } },
          503,
        );
      }
      options.inFlightTracker?.increment();
      try {
        await next();
        // Shutdown began while this request ran: ask the client to drop the
        // keep-alive connection so it reconnects to another replica.
        if (tracker.draining) {
          try {
            c.res.headers.set("Connection", "close");
          } catch {
            // immutable headers (e.g. a fetched Response passed through)
          }
        }
      } finally {
        options.inFlightTracker?.decrement();
      }
    });
  }

  // Only an explicit auth.enabled: false turns off client auth on non-admin
  // routes; omitting `enabled` keeps it on. /admin/* keeps its own adminAuth
  // gate below. Production startup refuses auth.enabled: false (see
  // validateProductionSafety). Client auth is enforced whether or not a
  // KeyStore is passed: without one, only config.auth.keys are accepted, and
  // with no keys at all every request is rejected (fail closed).
  const clientAuthEnabled = isClientAuthEnabled(config.auth);
  if (clientAuthEnabled) {
    if (keyStore === undefined && !hasConfigKeys(config.auth?.keys)) {
      console.error(
        "[auth] client auth is enabled but no credentials exist (no auth.keys and no key store): " +
          "every /v1/* request will be rejected with 401. Add auth.keys or set auth.enabled: false.",
      );
    }
    app.use(
      "*",
      authMiddleware({
        keyStore,
        bootstrapKey: options?.bootstrapKey,
        bootstrapReadOnlyKey: options?.bootstrapReadOnlyKey,
        bootstrap,
        skipPaths: ["/health", "/metrics", "/livez", "/readyz"],
        configKeys: () => config.auth?.keys,
      }),
    );
  }

  // Per-IP limiter: off unless configured (server.perIpRateLimit, or the
  // RATE_LIMIT_RPS / RATE_LIMIT_BURST env vars, which take precedence).
  const trustedProxies = parseTrustedProxies(process.env["TRUSTED_PROXIES"]);
  app.use(
    "/v1/*",
    perIpRateLimitMiddleware({
      rps: parseEnvNumber(process.env["RATE_LIMIT_RPS"]) ?? config.server?.perIpRateLimit?.rps,
      burst: parseEnvNumber(process.env["RATE_LIMIT_BURST"]) ?? config.server?.perIpRateLimit?.burst,
      resolveClientIp: (c) =>
        resolveClientIp(requestRemoteAddress(c), Object.fromEntries(c.req.raw.headers.entries()), trustedProxies),
    }),
  );

  app.use("*", requestTimeoutMiddleware(config.requestTimeout));

  // ── Handlers ──
  registerHealthHandler(app);
  registerLivenessHandler(app, gateway);
  registerReadinessHandler(
    app,
    gateway,
    [keyStore, options?.logStore],
    () => options?.inFlightTracker?.draining ?? false,
  );
  registerCapabilitiesHandler(app, gateway);
  registerChatHandler(app, gateway);
  registerCompletionsHandler(app, gateway);
  registerEmbeddingsHandler(app, gateway);
  registerImagesHandler(app, gateway);
  registerModelsHandler(app, gateway);

  const resolveTarget = (selector: { provider: string } | { model: string }) => {
    const target =
      "provider" in selector
        ? config.targets.find(
            (candidate) => candidate.name === selector.provider || candidate.provider === selector.provider,
          )
        : config.targets.find((candidate) => candidate.models?.includes(selector.model));
    if (target === undefined) return undefined;
    const expanded = expandTargetEnvRefs(target);
    // A target without baseURL uses its provider preset's default.
    return resolveProxyTarget({ ...expanded, baseURL: resolveBaseURL(expanded) });
  };

  // Gateway-owned routes answer any other method with 405 (never proxied:
  // e.g. GET /v1/chat/completions would list the upstream account's stored
  // completions with the operator key, S3-6).
  for (const [path, methods] of Object.entries(GATEWAY_ROUTE_METHODS)) {
    app.all(path, (c) =>
      c.json(
        {
          error: {
            message: `Method ${c.req.method} is not allowed on ${path}`,
            type: "invalid_request_error",
            code: "method_not_allowed",
          },
        },
        405,
        { Allow: methods.join(", ") },
      ),
    );
  }

  // Pass-through proxy for other /v1/* routes (e.g. /v1/responses, /v1/files).
  // It cannot apply circuit breakers, fallback, response-side plugins or
  // budget accrual (the body/usage shapes are unknown), so it is OPT-IN
  // (passthroughProxy.enabled: true). When enabled, before-request plugins
  // (rate-limit, budget check, word-filter on messages/input/prompt) run first.
  if (config.passthroughProxy?.enabled === true) {
    const isRouteAllowed = compileRouteAllowlist(config.passthroughProxy.routes ?? DEFAULT_PASSTHROUGH_ROUTES);
    app.all(
      "/v1/*",
      createProxyHandler({
        resolveTarget,
        isRouteAllowed,
        keyStore,
        // Normally the global auth middleware has already authenticated the
        // request; this fallback lets config.auth.keys through without a store.
        validateKey: (token) =>
          createProxyKeyValidator(
            (config.auth?.keys ?? []).filter((k): k is string => typeof k === "string" && k !== ""),
          )(token),
        environment: process.env["GATEWAY_ENV"],
        allowUnauthenticatedProxy: process.env["ALLOW_UNAUTHENTICATED_PROXY"] === "true" || !clientAuthEnabled,
        beforeForward: async (c, bodyText) => {
          try {
            const rewritten = await gateway.runPassthroughBeforePlugins(
              {
                traceId: c.req.header("X-Request-Id") ?? crypto.randomUUID(),
                metadata: { apiKey: (c.get as unknown as (k: string) => unknown)("apiKey") },
              },
              bodyText,
              new URL(c.req.url).pathname,
            );
            return rewritten === undefined ? undefined : { bodyText: rewritten };
          } catch (err) {
            if (err instanceof PluginRejectionError) {
              return respondError(c as unknown as Context, err);
            }
            throw err;
          }
        },
      }),
    );
  } else {
    app.all("/v1/*", (c) =>
      c.json(
        {
          error: {
            message: `Unknown route ${c.req.method} ${c.req.path}. The pass-through proxy is disabled (set passthroughProxy.enabled: true to forward other /v1/* routes).`,
            type: "invalid_request_error",
            code: "unknown_route",
          },
        },
        404,
      ),
    );
  }

  // ── Admin console (page shells + static assets) ──
  // Registered before the admin API so its auth middleware does not apply:
  // the shells carry no data (a browser navigation cannot send a Bearer
  // header); console.js loads everything from the authenticated /admin API.
  app.route("/", createDashboardApp());

  // ── Admin API ──
  const adminApp = createAdminApp(gateway, config, configPath, {
    keyStore,
    logStore: options?.logStore,
    adminSecret: options?.adminSecret,
    bootstrapKey: options?.bootstrapKey,
    bootstrapReadOnlyKey: options?.bootstrapReadOnlyKey,
    bootstrap,
  });
  app.route("/admin", adminApp);

  // ── Prometheus metrics endpoint ──
  if ((options?.metrics ?? metricsPlacement(config, config.server?.port ?? 3000)) === "main") {
    app.get("/metrics", () => metricsResponse());
  }

  return app;
}

function hasConfigKeys(keys: readonly unknown[] | undefined): boolean {
  return (keys ?? []).some((k) => typeof k === "string" && k !== "");
}

function parseEnvNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
