/**
 * MCP server lifecycle for the gateway: connect the configured servers,
 * build the tool executor, report per-server readiness (and the
 * `mcp_server_up` gauge).
 */

import type { GatewayConfig } from "../config/types.js";
import { McpExecutor } from "../mcp/executor.js";
import type { McpRegistry } from "../mcp/registry.js";
import { getMetrics } from "../metrics/metrics.js";

type McpServerOptions = {
  allowedTools?: string[];
  maxCallDepth?: number;
  timeoutSeconds?: number;
  required?: boolean;
};

/** One configured MCP server with the runtime options the registry accepts. */
export type McpServerRuntimeConfig = GatewayConfig["mcpServers"] extends readonly (infer T)[]
  ? T & McpServerOptions
  : McpServerOptions;

/** The tool executor for the configured servers (null when none); depth from the first server. */
export function createMcpExecutor(config: GatewayConfig, registry: McpRegistry): McpExecutor | null {
  if (!config.mcpServers || config.mcpServers.length === 0) return null;
  const first = config.mcpServers[0] as McpServerRuntimeConfig;
  return new McpExecutor(registry, first.maxCallDepth);
}

/**
 * Connect all servers concurrently: each handshake is bounded by its own
 * timeout, and one slow or failing server must not delay the others. A
 * failure is logged; required-server readiness reports it.
 */
export async function connectMcpServers(config: GatewayConfig, registry: McpRegistry): Promise<void> {
  if (!config.mcpServers || config.mcpServers.length === 0) return;
  await Promise.all(
    config.mcpServers.map(async (serverConfig) => {
      try {
        const runtime = serverConfig as McpServerRuntimeConfig;
        await registry.addServer(serverConfig, {
          allowedTools: runtime.allowedTools,
          maxCallDepth: runtime.maxCallDepth,
          timeoutSeconds: runtime.timeoutSeconds,
          required: runtime.required,
        });
      } catch (err) {
        console.error(`[gateway] MCP server "${serverConfig.name}" failed to connect: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  mcpReadiness(registry);
}

/** Current readiness state for each configured MCP server (also updates the up gauge). */
export function mcpReadiness(registry: McpRegistry): Readonly<Record<string, string>> {
  const states: Record<string, string> = {};
  const metrics = getMetrics();
  for (const name of registry.serverNames()) {
    states[name] = registry.readiness(name);
    metrics.setMcpServerUp(name, states[name] === "ready");
  }
  return states;
}
