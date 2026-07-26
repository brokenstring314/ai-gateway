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

export type { McpServerConfig } from "../config/types.js";
