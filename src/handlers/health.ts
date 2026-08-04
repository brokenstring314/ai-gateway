/**
 * Health handler — GET /health
 */

import type { AppType } from "../app.js";
import type { Gateway } from "../gateway.js";
import type { ConfigStore } from "../persistence/config-store.js";

export function registerHealthHandler(app: AppType): void {
  app.get("/health", (c) => {
    return c.json({ status: "ok" }, 200);
  });
}

export function registerLivenessHandler(app: AppType): void {
  app.get("/livez", (c) => {
    return c.json({ status: "ok" }, 200);
  });
}

export function registerReadinessHandler(
  app: AppType,
  gateway: Gateway,
  configStore?: ConfigStore,
): void {
  app.get("/readyz", (c) => {
    const registry = gateway.getRegistry();
    const config = gateway.getConfig();
    let storeReady = true;
    if (configStore) {
      try {
        configStore.ping();
      } catch {
        storeReady = false;
      }
    }
    const providerReady = Boolean(config && registry.size > 0);
    const gatewayReadiness = gateway as unknown as {
      isMcpReady?: () => boolean;
      hasOpenCircuitBreaker?: () => boolean;
      mcpReadiness?: () => Readonly<Record<string, string>>;
    };
    const mcpReady = gatewayReadiness.isMcpReady?.() ?? true;
    const breakerReady = !(gatewayReadiness.hasOpenCircuitBreaker?.() ?? false);
    const ready = providerReady && storeReady && mcpReady && breakerReady;
    return c.json({
      status: ready ? "ok" : "not ready",
      providers: providerReady,
      configStore: storeReady,
      mcpServers: gatewayReadiness.mcpReadiness?.() ?? {},
      circuitBreakers: breakerReady,
    }, ready ? 200 : 503);
  });
}
