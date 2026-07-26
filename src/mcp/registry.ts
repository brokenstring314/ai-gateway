/**
 * MCP registry — tracks all MCP clients keyed by server name.
 */

import type { McpServerConfig } from "../config/types.js";
import type { McpTool } from "./types.js";
import { McpClient } from "./client.js";

export class McpRegistry {
  private readonly clients = new Map<string, McpClient>();

  /** Connect to an MCP server and register its client. */
  async addServer(config: McpServerConfig): Promise<McpClient> {
    const existing = this.clients.get(config.name);
    if (existing) {
      existing.close();
    }

    const client = new McpClient(config);
    await client.connect();
    this.clients.set(config.name, client);
    return client;
  }

  /** Register an already-connected client. */
  register(name: string, client: McpClient): void {
    const existing = this.clients.get(name);
    if (existing) {
      existing.close();
    }
    this.clients.set(name, client);
  }

  /** Get a client by server name. */
  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  /** Get combined tool list from all connected servers. */
  allTools(): readonly McpTool[] {
    const tools: McpTool[] = [];
    for (const client of this.clients.values()) {
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
  }
}
