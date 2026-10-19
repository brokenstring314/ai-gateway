// Backlog #5: the MCP loop depth was read from the first `mcpServers` entry
// only. It is now the smallest maxCallDepth set on any server (default 5 when
// none sets it), as in the Go original (minPositiveMaxCallDepth).
import { describe, expect, it } from "bun:test";
import type { GatewayConfig } from "@/config/types";
import { createMcpExecutor } from "@/core/mcp-runtime";
import { McpRegistry } from "@/mcp/registry";
import { base, ok } from "./_h";

const server = (name: string, extra: Record<string, unknown> = {}) => ({ name, command: "node", ...extra });
const depth = (servers: Record<string, unknown>[]) =>
  createMcpExecutor({ ...base(), mcpServers: servers } as unknown as GatewayConfig, new McpRegistry())?.maxDepth;

describe("MCP maxCallDepth across servers (backlog #5)", () => {
  it("a lower limit on a later server applies", () => {
    expect(depth([server("a", { maxCallDepth: 5 }), server("b", { maxCallDepth: 2 })])).toBe(2);
  });

  it("a server without maxCallDepth does not impose the default on the others", () => {
    expect(depth([server("a"), server("b", { maxCallDepth: 8 })])).toBe(8);
  });

  it("defaults to 5 when no server sets it", () => {
    expect(depth([server("a"), server("b")])).toBe(5);
  });

  it("validated configs keep the same semantics (no per-server default injected)", async () => {
    const { parseConfig } = await import("@/config/schema");
    const cfg = parseConfig(base({ mcpServers: [server("a"), server("b", { maxCallDepth: 8 })] }));
    ok(cfg);
    expect(createMcpExecutor(cfg as GatewayConfig, new McpRegistry())?.maxDepth).toBe(8);
  });
});
