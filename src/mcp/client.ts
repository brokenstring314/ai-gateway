/**
 * MCP client — connects to tool servers via stdio transport.
 * Implements the MCP 2025-03-26 protocol subset: initialize, tools/list, tools/call.
 */

import type { McpServerConfig } from "../config/types.js";
import type {
  McpTool,
  McpInitializeResult,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class McpClient {
  private subprocess: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private buffer = "";
  private initialized = false;
  private toolsCache: McpTool[] = [];
  private reading = false;

  constructor(
    private readonly config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    if (this.config.type !== "stdio") {
      throw new Error(`MCP transport "${this.config.type}" is not supported yet — only stdio`);
    }

    if (!this.config.command) {
      throw new Error("MCP stdio server requires a command");
    }

    this.subprocess = Bun.spawn({
      cmd: [this.config.command, ...(this.config.args ?? [])],
      env: { ...Bun.env, ...this.config.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

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
  }

  listTools(): readonly McpTool[] {
    return this.toolsCache;
  }

  async refreshTools(): Promise<void> {
    const result = await this.sendRequest<{ tools: McpTool[] }>("tools/list", {});
    this.toolsCache = result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.sendRequest<{
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>("tools/call", { name, arguments: args });

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
    for (const [, pending] of this.pending) {
      pending.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
  }

  get serverName(): string {
    return this.config.name;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  private get stdinPipe(): Bun.FileSink | undefined {
    const stdin = this.subprocess?.stdin;
    if (stdin && typeof stdin !== "number") return stdin;
    return undefined;
  }

  private get stdoutPipe(): ReadableStream<Uint8Array> | undefined {
    const stdout = this.subprocess?.stdout;
    if (stdout && typeof stdout !== "number") return stdout;
    return undefined;
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pipe = this.stdinPipe;
      if (!pipe) {
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
        for (const [, pending] of this.pending) {
          pending.reject(new Error("MCP connection closed"));
        }
        this.pending.clear();
      } finally {
        this.reading = false;
      }
    };

    pump();
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
