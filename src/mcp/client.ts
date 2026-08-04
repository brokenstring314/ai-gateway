/**
 * MCP client — connects to tool servers via stdio transport.
 * Implements the MCP 2025-03-26 protocol subset: initialize, tools/list, tools/call.
 *
 * Transport is inferred from the server config (`command` => stdio, `url` => http)
 * rather than depending on the legacy `type` field. Runtime options (allowedTools,
 * timeoutSeconds, ...) are supplied separately from the config schema.
 */

import type { McpServerConfig } from "../config/types.js";
import type {
  McpTool,
  McpServerOptions,
  McpServerReadiness,
  McpTransport,
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

/** Production spawner backed by Bun. Only evaluated when a connection is made. */
export const defaultSpawner: McpSpawner = (config: McpServerConfig): McpSubprocess => {
  const proc = Bun.spawn({
    cmd: [config.command ?? "", ...(config.args ?? [])],
    env: { ...Bun.env, ...config.env },
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
  private reading = false;
  private state: McpServerReadiness = "unready";
  private readonly allowedTools: ReadonlySet<string> | null;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: McpServerConfig,
    options: McpServerOptions = {},
    private readonly spawn: McpSpawner = defaultSpawner,
  ) {
    this.allowedTools =
      options.allowedTools && options.allowedTools.length > 0
        ? new Set(options.allowedTools)
        : null;
    this.timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  async connect(): Promise<void> {
    const transport = this.inferTransport();
    if (transport === "http") {
      throw new Error(`MCP transport "http" is not supported yet — only stdio`);
    }
    if (!this.config.command) {
      throw new Error("MCP stdio server requires a command");
    }

    this.state = "unready";
    try {
      this.subprocess = this.spawn(this.config);

      this.state = "connected";
      this.startReading();

      await this.sendRequest<McpInitializeResult>(
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "ai-gateway", version: "0.1.0" },
        },
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
    const result = await this.sendRequest<{ tools: McpTool[] }>("tools/list", {});
    this.toolsCache = result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.isToolAllowed(name)) {
      throw new Error(
        `MCP tool "${name}" is not allowed by this server's allowedTools configuration`,
      );
    }

    const result = await this.sendRequest<{
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>(
      "tools/call",
      { name, arguments: args },
      { timeoutMs: this.timeoutMs, label: `MCP tool "${name}"` },
    );

    const text = result.content
      .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");

    if (result.isError) {
      throw new Error(`MCP tool "${name}" returned error: ${text || "unknown error"}`);
    }

    return text;
  }

  close(): void {
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

  /** Infer the transport from the config: command => stdio, url => http. */
  private inferTransport(): McpTransport {
    if (this.config.command) return "stdio";
    if (this.config.url) return "http";
    throw new Error("MCP server requires either a command (stdio) or url (http)");
  }

  private get stdinPipe(): { write(data: string): void } | undefined {
    const stdin = this.subprocess?.stdin;
    if (stdin && typeof stdin !== "number") return stdin;
    return undefined;
  }

  private get stdoutPipe(): ReadableStream<Uint8Array> | undefined {
    const stdout = this.subprocess?.stdout;
    if (stdout && typeof stdout !== "number") return stdout;
    return undefined;
  }

  private sendRequest<T>(
    method: string,
    params: Record<string, unknown>,
    options?: SendRequestOptions,
  ): Promise<T> {
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
      const timeoutSignal =
        options?.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
      if (timeoutSignal) {
        timeoutSignal.addEventListener("abort", () => {
          this.pending.delete(id);
          reject(
            new McpToolTimeoutError(
              `${options?.label ?? method} timed out after ${options?.timeoutMs}ms`,
            ),
          );
        });
      }

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });

      const payload = JSON.stringify(request) + "\n";
      try {
        pipe.write(payload);
      } catch (err) {
        this.pending.delete(id);
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

  private startReading(): void {
    const stream = this.stdoutPipe;
    if (this.reading || !stream) return;
    this.reading = true;

    const reader = stream.getReader();

    const pump = async (): Promise<void> => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          this.buffer += new TextDecoder().decode(value);
          this.processBuffer();
        }
      } catch {
        // stream error — handled by handleDisconnect below
      } finally {
        this.reading = false;
      }
      this.handleDisconnect("stdio stream ended");
    };

    pump();
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
      pending.reject(
        new Error(`MCP error ${response.error.code}: ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }
}
