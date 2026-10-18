/**
 * MCP client — connects to tool servers via stdio transport.
 * Implements the MCP 2025-03-26 protocol subset: initialize, tools/list, tools/call.
 *
 * Transport: stdio only (`command`)
 * rather than depending on the legacy `type` field. Runtime options (allowedTools,
 * timeoutSeconds, ...) are supplied separately from the config schema.
 */

import type { McpServerConfig } from "../config/types.js";
import { VERSION } from "../version.js";
import type {
  McpTool,
  McpServerOptions,
  McpServerReadiness,
  McpInitializeResult,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

export const DEFAULT_TIMEOUT_SECONDS = 30;

/** Stable error thrown when a tool call exceeds its timeout budget. */
export class McpToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolTimeoutError";
  }
}

/**
 * Minimal structural view of a spawned stdio subprocess. Kept structural so
 * tests can inject a fake without exercising Bun.
 */
export interface McpSubprocess {
  stdin: { write(data: string): void } | number;
  stdout: ReadableStream<Uint8Array> | number;
  kill(): void;
}

/** Spawns the stdio subprocess for a server config. Injectable for tests. */
export type McpSpawner = (config: McpServerConfig) => McpSubprocess;

/**
 * Environment variables an MCP stdio server inherits from the gateway by
 * default. Everything else (provider API keys, ADMIN_BOOTSTRAP_KEY, OTLP
 * tokens, cloud credentials, ...) is withheld; pass what a server needs via
 * `env`, or name extra variables in `inheritEnv`.
 */
export const MCP_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  // Windows equivalents needed to start most processes.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

/**
 * Build the environment for an MCP subprocess: the allowlist (plus any names
 * in `inheritEnv`), or the whole parent env when `inheritEnv: true`, then
 * `config.env` on top.
 */
export function buildMcpEnv(
  config: Pick<McpServerConfig, "env" | "inheritEnv">,
  parentEnv: Record<string, string | undefined> = Bun.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.inheritEnv === true) {
    for (const [name, value] of Object.entries(parentEnv)) {
      if (value !== undefined) env[name] = value;
    }
  } else {
    const names = [...MCP_ENV_ALLOWLIST, ...(Array.isArray(config.inheritEnv) ? config.inheritEnv : [])];
    for (const name of names) {
      const value = parentEnv[name];
      if (value !== undefined) env[name] = value;
    }
  }
  return { ...env, ...config.env };
}

/** Production spawner backed by Bun. Only evaluated when a connection is made. */
export const defaultSpawner: McpSpawner = (config: McpServerConfig): McpSubprocess => {
  const proc = Bun.spawn({
    cmd: [config.command ?? "", ...(config.args ?? [])],
    env: buildMcpEnv(config),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc;
};

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface SendRequestOptions {
  /** Per-request timeout in ms — the JSON-RPC response races an AbortSignal timer. */
  timeoutMs?: number;
  /** Human-readable label used in timeout error messages. */
  label?: string;
}

export class McpClient {
  private subprocess: McpSubprocess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private buffer = "";
  private initialized = false;
  private toolsCache: McpTool[] = [];
  private state: McpServerReadiness = "unready";
  private closed = false;
  private disconnectListener: ((reason: string) => void) | null = null;
  private readonly allowedTools: ReadonlySet<string> | null;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: McpServerConfig,
    options: McpServerOptions = {},
    private readonly spawn: McpSpawner = defaultSpawner,
  ) {
    this.allowedTools = options.allowedTools && options.allowedTools.length > 0 ? new Set(options.allowedTools) : null;
    this.timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  async connect(): Promise<void> {
    // Only stdio is supported (the never-implemented http transport was
    // removed from the schema in 0.2.0).
    if (!this.config.command) {
      throw new Error("MCP stdio server requires a command");
    }

    this.state = "unready";
    this.closed = false;
    this.buffer = "";
    try {
      this.subprocess = this.spawn(this.config);

      this.state = "connected";
      this.startReading(this.subprocess);

      await this.sendRequest<McpInitializeResult>(
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "ai-gateway", version: VERSION },
        },
        { timeoutMs: this.timeoutMs, label: `MCP server "${this.config.name}" initialize` },
      );

      this.sendNotification("notifications/initialized", {});
      this.initialized = true;

      await this.refreshTools();
      // Only promote to initialized if the connection survived the handshake —
      // a disconnect that raced the tools/list response must stay unready.
      if (this.state === "connected") {
        this.state = "initialized";
      }
    } catch (err) {
      // Tear down the subprocess too — a hung server must not linger after a
      // failed (e.g. timed-out) handshake.
      if (this.subprocess) {
        try {
          this.subprocess.kill();
        } catch {
          // best-effort
        }
        this.subprocess = null;
      }
      this.handleDisconnect("connection failed");
      throw err;
    }
  }

  listTools(): readonly McpTool[] {
    if (this.state !== "initialized") return [];
    const allowedTools = this.allowedTools;
    if (allowedTools === null) return this.toolsCache;
    return this.toolsCache.filter((tool) => allowedTools.has(tool.name));
  }

  async refreshTools(): Promise<void> {
    const result = await this.sendRequest<{ tools: McpTool[] }>(
      "tools/list",
      {},
      { timeoutMs: this.timeoutMs, label: `MCP server "${this.config.name}" tools/list` },
    );
    this.toolsCache = result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.isToolAllowed(name)) {
      throw new Error(`MCP tool "${name}" is not allowed by this server's allowedTools configuration`);
    }

    const result = await this.sendRequest<{
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>("tools/call", { name, arguments: args }, { timeoutMs: this.timeoutMs, label: `MCP tool "${name}"` });

    const text = result.content
      .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");

    if (result.isError) {
      throw new Error(`MCP tool "${name}" returned error: ${text || "unknown error"}`);
    }

    return text;
  }

  /**
   * Called when an established (or handshaking) connection drops on its own:
   * the process exited or its stdout closed. Not called for close() or for a
   * connect() that throws (the caller sees the error).
   */
  setDisconnectListener(listener: ((reason: string) => void) | null): void {
    this.disconnectListener = listener;
  }

  close(): void {
    this.closed = true;
    if (this.subprocess) {
      this.subprocess.kill();
      this.subprocess = null;
    }
    this.handleDisconnect("client closed");
  }

  get serverName(): string {
    return this.config.name;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get readiness(): McpServerReadiness {
    return this.state;
  }

  private isToolAllowed(name: string): boolean {
    return this.allowedTools === null || this.allowedTools.has(name);
  }

  private get stdinPipe(): { write(data: string): void } | undefined {
    const stdin = this.subprocess?.stdin;
    if (stdin && typeof stdin !== "number") return stdin;
    return undefined;
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>, options?: SendRequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pipe = this.stdinPipe;
      if (!pipe || this.state === "unready") {
        reject(new Error("MCP client not connected"));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      // The JSON-RPC response and the AbortSignal timeout race — whichever fires
      // first settles the promise. On timeout the pending entry is cleaned up.
      // Every request is bounded — defaults to the server's configured timeout so
      // no handshake or call can hang forever.
      const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new McpToolTimeoutError(`${options?.label ?? method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result: unknown) => {
          clearTimeout(timer);
          resolve(result as T);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      const payload = JSON.stringify(request) + "\n";
      try {
        pipe.write(payload);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`MCP write failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const pipe = this.stdinPipe;
    if (!pipe) return;

    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const payload = JSON.stringify(notification) + "\n";
    try {
      pipe.write(payload);
    } catch {
      // swallow — notification is best-effort
    }
  }

  private startReading(proc: McpSubprocess): void {
    const stream = typeof proc.stdout !== "number" ? proc.stdout : undefined;
    if (!stream) return;

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    // Each pump belongs to one subprocess: a late EOF from a killed process
    // must not tear down a newer connection after a reconnect.
    const isCurrent = (): boolean => this.subprocess === proc;

    const pump = async (): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || !isCurrent()) break;

          this.buffer += decoder.decode(value, { stream: true });
          this.processBuffer();
        }
      } catch {
        // stream error — handled below
      }
      if (!isCurrent()) return;
      const wasUp = this.state !== "unready";
      this.subprocess = null;
      this.handleDisconnect("stdio stream ended");
      if (wasUp && !this.closed) this.disconnectListener?.("process exited or closed stdout");
    };

    void pump();
  }

  /** Mark the connection unready, drop cached tools, and reject in-flight calls. */
  private handleDisconnect(reason: string): void {
    const wasReady = this.state !== "unready";
    this.state = "unready";
    this.initialized = false;
    this.toolsCache = [];

    if (wasReady || this.pending.size > 0) {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP connection closed: ${reason}`));
      }
      this.pending.clear();
    }
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        const response: JsonRpcResponse = JSON.parse(line);
        this.handleResponse(response);
      } catch {
        // Skip malformed lines
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }
}
