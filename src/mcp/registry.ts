/**
 * MCP registry — tracks all MCP clients keyed by server name.
 * Exposes per-server readiness and required-server readiness queries.
 */

import type { McpServerConfig } from "../config/types.js";
import type {
  McpServerOptions,
  McpServerReadiness,
  McpTool,
  McpToolRegistry,
} from "./types.js";
import { McpClient, defaultSpawner } from "./client.js";
import type { McpSpawner } from "./client.js";

export class McpRegistry implements McpToolRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly serverOptions = new Map<string, McpServerOptions>();
  private readonly requiredServers = new Set<string>();

  constructor(private readonly spawner: McpSpawner = defaultSpawner) {}

  /** Connect to an MCP server and register its client. */
  async addServer(config: McpServerConfig, options?: McpServerOptions): Promise<McpClient> {
    const existing = this.clients.get(config.name);
    if (existing) {
      existing.close();
    }

    // Track required servers even if the connection fails, so a failed required
    // server keeps requiredServersReady() false.
    if (options?.required) {
      this.requiredServers.add(config.name);
    }

    const client = new McpClient(config, options, this.spawner);
    await client.connect();
    this.clients.set(config.name, client);
    this.serverOptions.set(config.name, options ?? {});
    return client;
  }

  /** Register an already-connected client. */
  register(name: string, client: McpClient, options?: McpServerOptions): void {
    const existing = this.clients.get(name);
    if (existing) {
      existing.close();
    }
    this.clients.set(name, client);
    this.serverOptions.set(name, options ?? {});
    if (options?.required) {
      this.requiredServers.add(name);
    }
  }

  /** Get a client by server name. */
  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  /** Runtime options recorded for a server (undefined if never registered). */
  getOptions(name: string): McpServerOptions | undefined {
    return this.serverOptions.get(name);
  }

  /** Readiness of a server; "unready" when unknown or disconnected. */
  readiness(name: string): McpServerReadiness {
    return this.clients.get(name)?.readiness ?? "unready";
  }

  /**
   * Whether every server flagged `required` is fully initialized.
   * Unregistered, failed, or disconnected required servers make this false;
   * with no required servers it is trivially true.
   */
  requiredServersReady(): boolean {
    for (const name of this.requiredServers) {
      const client = this.clients.get(name);
      if (!client || client.readiness !== "initialized") return false;
    }
    return true;
  }

  /** Get combined tool list from all ready servers (unready servers are not advertised). */
  allTools(): readonly McpTool[] {
    const tools: McpTool[] = [];
    for (const client of this.clients.values()) {
      if (client.readiness !== "initialized") continue;
      tools.push(...client.listTools());
    }
    return tools;
  }

  /** List all registered server names. */
  serverNames(): readonly string[] {
    return [...this.clients.keys()];
  }

  /** Close all clients and clear the registry. */
  closeAll(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.serverOptions.clear();
    this.requiredServers.clear();
  }
}
