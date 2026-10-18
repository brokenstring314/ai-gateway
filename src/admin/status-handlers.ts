/**
 * Admin API — GET /admin/status: one read for the admin console overview.
 *
 * Returns the caller's scopes (so the console can hide write actions from
 * read_only credentials), gateway health (circuit breakers per target,
 * upstreamAvailable, MCP server states, registered providers) and an
 * in-process request summary from the Prometheus registry. Readiness itself
 * (status, stores, draining) stays on the public GET /readyz.
 */

import type { Context } from "hono";
import type { Gateway } from "../gateway.js";
import { getMetrics } from "../metrics/metrics.js";
import { VERSION } from "../version.js";

interface GatewayHealth {
  mcpReadiness?: () => Readonly<Record<string, string>>;
  circuitBreakerStates?: () => Readonly<Record<string, string>>;
  hasUsableTarget?: () => boolean;
  getRegistry?: () => { size: number };
}

/** GET /admin/status — scopes, gateway health and request summary. */
export function getStatusHandler(gateway: Gateway) {
  const g = gateway as unknown as GatewayHealth;
  return async (c: Context) => {
    const scopes = (c.get("keyScopes") as string[] | undefined) ?? [];
    return c.json({
      version: VERSION,
      scopes,
      providers: g.getRegistry?.().size ?? 0,
      upstreamAvailable: g.hasUsableTarget?.() ?? true,
      circuitBreakers: g.circuitBreakerStates?.() ?? {},
      mcpServers: g.mcpReadiness?.() ?? {},
      requests: await getMetrics().requestSummary(),
    });
  };
}
