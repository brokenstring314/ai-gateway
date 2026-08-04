/**
 * MCP (Model Context Protocol) types.
 * Covers the subset of MCP 2025-03-26 needed for tool discovery and invocation.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface McpToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/** Capabilities returned by the MCP server during initialization. */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
}

/** Result of the MCP initialize handshake. */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: { name: string; version?: string };
}

/** JSON-RPC request envelope. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC response envelope (success). */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP transport, inferred from the server config (`command` => stdio, `url` => http)
 * rather than depending on the legacy `type` field.
 */
export type McpTransport = "stdio" | "http";

/**
 * Readiness of an MCP server connection:
 * - "connected": transport is up but the initialize handshake has not completed
 * - "initialized": handshake done and tools listed — ready for use
 * - "unready": not connected, connection failed, or the process exited/closed
 */
export type McpServerReadiness = "connected" | "initialized" | "unready";

/**
 * Runtime options for an MCP server. These are not part of the config schema —
 * they are supplied at registration time by the gateway wiring.
 */
export interface McpServerOptions {
  /** Whitelist of tool names exposed to the model. Empty/absent means all tools. */
  allowedTools?: string[];
  /** Maximum agentic tool-call depth (default: 5). */
  maxCallDepth?: number;
  /** Per-tool-call timeout in seconds (default: 30). */
  timeoutSeconds?: number;
  /** Whether the gateway requires this server to be ready before serving. */
  required?: boolean;
}

/**
 * Minimal tool-invocation surface the executor needs from a server client.
 * Kept structural so tests can substitute fakes without mocking internals.
 */
export interface McpToolCallTarget {
  listTools(): readonly McpTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

/** Minimal registry surface the executor needs. */
export interface McpToolRegistry {
  allTools(): readonly McpTool[];
  serverNames(): readonly string[];
  getClient(name: string): McpToolCallTarget | undefined;
}

export type { McpServerConfig } from "../config/types.js";
