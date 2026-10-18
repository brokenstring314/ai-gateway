/**
 * Health handler — GET /health
 */

import type { AppType } from "../app.js";
import type { Gateway } from "../gateway.js";

export function registerHealthHandler(app: AppType): void {
  app.get("/health", (c) => {
    return c.json({ status: "ok" }, 200);
  });
}

/**
 * GET /livez — process liveness. Fails (503) only when a required MCP server
 * has failed too many consecutive reconnect attempts: restarting the pod is
 * then the remedy, whereas readiness alone would leave a zombie replica.
 */
export function registerLivenessHandler(app: AppType, gateway?: Gateway): void {
  app.get("/livez", (c) => {
    const live = (gateway as unknown as { isMcpLive?: () => boolean } | undefined)?.isMcpLive?.() ?? true;
    if (!live) {
      return c.json({ status: "failing", reason: "required MCP server keeps failing to reconnect" }, 503);
    }
    return c.json({ status: "ok" }, 200);
  });
}

/**
 * GET /readyz — Kubernetes / load-balancer readiness.
 *
 * Ready = config loaded with at least one provider, config store reachable,
 * required MCP servers initialized, and the process is not draining.
 *
 * Upstream circuit-breaker state deliberately does NOT affect readiness:
 * every replica talks to the same upstreams, so an upstream outage opens the
 * same breakers on every pod at once. Failing readiness on it would pull the
 * whole fleet out of the load balancer and turn a partial (or even fully
 * failed-over) upstream outage into a total gateway outage, while removing a
 * pod can never fix an upstream. Breaker states and whether any target is
 * still usable are reported in the body (`circuitBreakers`,
 * `upstreamAvailable`) for dashboards and alerts instead.
 *
 * While draining after SIGTERM/SIGINT, /readyz answers 503 immediately so the
 * load balancer stops routing new traffic to this pod.
 */
export function registerReadinessHandler(
  app: AppType,
  gateway: Gateway,
  stores: ReadonlyArray<{ ping(): void } | undefined> = [],
  isDraining?: () => boolean,
): void {
  app.get("/readyz", (c) => {
    const registry = gateway.getRegistry();
    const config = gateway.getConfig();
    let storeReady = true;
    for (const store of stores) {
      if (store === undefined) continue;
      try {
        store.ping();
      } catch {
        storeReady = false;
      }
    }
    const providerReady = Boolean(config && registry.size > 0);
    const gatewayReadiness = gateway as unknown as {
      isMcpReady?: () => boolean;
      mcpReadiness?: () => Readonly<Record<string, string>>;
      circuitBreakerStates?: () => Readonly<Record<string, string>>;
      hasUsableTarget?: () => boolean;
    };
    const mcpReady = gatewayReadiness.isMcpReady?.() ?? true;
    const draining = isDraining?.() ?? false;
    const ready = providerReady && storeReady && mcpReady && !draining;
    return c.json(
      {
        status: draining ? "draining" : ready ? "ok" : "not ready",
        providers: providerReady,
        stores: storeReady,
        mcpServers: gatewayReadiness.mcpReadiness?.() ?? {},
        circuitBreakers: gatewayReadiness.circuitBreakerStates?.() ?? {},
        upstreamAvailable: gatewayReadiness.hasUsableTarget?.() ?? true,
        draining,
      },
      ready ? 200 : 503,
    );
  });
}
