/**
 * MCP registry — tracks all MCP clients keyed by server name.
 * Exposes per-server readiness and required-server readiness queries.
 *
 * It also supervises servers it connected itself (addServer): when a server
 * fails to connect or its process dies, it is reconnected with exponential
 * backoff and every disconnect / attempt / recovery is logged. A required
 * server that fails `livenessFailureThreshold` consecutive attempts makes
 * requiredServersLive() false so /livez fails and the orchestrator restarts
 * the pod instead of leaving a permanently not-ready replica.
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

export interface McpRestartPolicy {
  /** Delay before the first reconnect attempt. Default 1000 ms. */
  initialDelayMs: number;
  /** Upper bound for the backoff delay. Default 60000 ms. */
  maxDelayMs: number;
  /** Backoff multiplier per consecutive failure. Default 2. */
  multiplier: number;
  /**
   * Consecutive failed attempts after which a required server makes
   * requiredServersLive() false (0 = never). Default 5.
   */
  livenessFailureThreshold: number;
}

export const DEFAULT_MCP_RESTART_POLICY: Readonly<McpRestartPolicy> = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
  livenessFailureThreshold: 5,
};

interface Supervision {
  timer: ReturnType<typeof setTimeout> | null;
  attempting: boolean;
  /** Consecutive failed connect attempts since the last successful connect. */
  failures: number;
  stopped: boolean;
}

export class McpRegistry implements McpToolRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly serverOptions = new Map<string, McpServerOptions>();
  private readonly requiredServers = new Set<string>();
  private readonly supervision = new Map<string, Supervision>();
  private readonly policy: McpRestartPolicy;

  constructor(
    private readonly spawner: McpSpawner = defaultSpawner,
    policy: Partial<McpRestartPolicy> = {},
    private readonly log: (level: "info" | "warn" | "error", message: string) => void = defaultLog,
  ) {
    this.policy = { ...DEFAULT_MCP_RESTART_POLICY, ...policy };
  }

  /**
   * Connect to an MCP server, register its client and supervise it. If the
   * first connect fails the error is rethrown, but the client stays
   * registered (unready) and reconnects in the background.
   */
  async addServer(config: McpServerConfig, options?: McpServerOptions): Promise<McpClient> {
    this.stopSupervision(config.name);
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
    this.clients.set(config.name, client);
    this.serverOptions.set(config.name, options ?? {});
    const sup: Supervision = { timer: null, attempting: true, failures: 0, stopped: false };
    this.supervision.set(config.name, sup);
    client.setDisconnectListener((reason) => {
      if (sup.stopped || sup.attempting) return;
      this.log("warn", `[mcp] server "${config.name}" disconnected (${reason}); its tools are unavailable until it reconnects`);
      this.scheduleReconnect(config.name, client, sup);
    });

    try {
      await client.connect();
      sup.attempting = false;
      return client;
    } catch (err) {
      sup.attempting = false;
      sup.failures = 1;
      this.scheduleReconnect(config.name, client, sup);
      throw err;
    }
  }

  /** Delay before the next attempt after `failures` consecutive failures. */
  private backoffDelay(failures: number): number {
    const { initialDelayMs, maxDelayMs, multiplier } = this.policy;
    const exp = Math.max(0, failures - 1);
    return Math.min(maxDelayMs, initialDelayMs * multiplier ** exp);
  }

  private scheduleReconnect(name: string, client: McpClient, sup: Supervision): void {
    if (sup.stopped || sup.timer !== null || sup.attempting) return;
    const delay = this.backoffDelay(sup.failures);
    this.log("info", `[mcp] server "${name}": reconnect attempt ${sup.failures + 1} in ${delay}ms`);
    const timer = setTimeout(() => {
      sup.timer = null;
      void this.attemptReconnect(name, client, sup);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    sup.timer = timer;
  }

  private async attemptReconnect(name: string, client: McpClient, sup: Supervision): Promise<void> {
    if (sup.stopped) return;
    sup.attempting = true;
    try {
      await client.connect();
      sup.attempting = false;
      if (sup.stopped) return;
      this.log("info", `[mcp] server "${name}" reconnected after ${sup.failures + 1} attempt(s)`);
      sup.failures = 0;
    } catch (err) {
      sup.attempting = false;
      if (sup.stopped) return;
      sup.failures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      this.log("warn", `[mcp] server "${name}" reconnect attempt ${sup.failures} failed: ${msg}`);
      const threshold = this.policy.livenessFailureThreshold;
      if (this.requiredServers.has(name) && threshold > 0 && sup.failures === threshold) {
        this.log("error", `[mcp] required server "${name}" failed ${threshold} consecutive reconnect attempts; /livez now reports failure`);
      }
      this.scheduleReconnect(name, client, sup);
    }
  }

  private stopSupervision(name: string): void {
    const sup = this.supervision.get(name);
    if (!sup) return;
    sup.stopped = true;
    if (sup.timer !== null) clearTimeout(sup.timer);
    sup.timer = null;
    this.supervision.delete(name);
  }

  /** Consecutive failed connect attempts for a supervised server (0 when healthy or unknown). */
  consecutiveFailures(name: string): number {
    return this.supervision.get(name)?.failures ?? 0;
  }

  /**
   * False when a required server has failed livenessFailureThreshold
   * consecutive (re)connect attempts. Used by /livez.
   */
  requiredServersLive(): boolean {
    const threshold = this.policy.livenessFailureThreshold;
    if (threshold <= 0) return true;
    for (const name of this.requiredServers) {
      if ((this.supervision.get(name)?.failures ?? 0) >= threshold) return false;
    }
    return true;
  }

  /** Register an already-connected client. */
  register(name: string, client: McpClient, options?: McpServerOptions): void {
    this.stopSupervision(name);
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
    for (const name of [...this.supervision.keys()]) {
      this.stopSupervision(name);
    }
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.serverOptions.clear();
    this.requiredServers.clear();
  }
}

function defaultLog(level: "info" | "warn" | "error", message: string): void {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.log(message);
}
