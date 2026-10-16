import { describe, expect, it, spyOn } from "bun:test";
import { McpClient, McpRegistry, McpToolTimeoutError } from "@/mcp";
import type { McpServerConfig, McpSpawner, McpSubprocess } from "@/mcp";
import { Gateway } from "@/gateway";

const line = (o: unknown) => JSON.stringify(o) + "\n";

/** Fake stdio server. `answer` decides per method whether to reply. */
function spawner(answer: (name: string, method: string) => boolean, killed: string[] = []): McpSpawner {
  return (config) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const send = (o: unknown) => ctrl.enqueue(new TextEncoder().encode(line(o)));
    const proc: McpSubprocess = {
      stdin: {
        write(data: string) {
          for (const l of data.split("\n")) {
            if (!l) continue;
            const msg = JSON.parse(l);
            if (msg.id === undefined || !answer(config.name, msg.method)) continue;
            queueMicrotask(() => {
              if (msg.method === "initialize") {
                send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "x" } } });
              } else if (msg.method === "tools/list") {
                send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: `${config.name}_tool`, inputSchema: {} }] } });
              }
            });
          }
        },
      },
      stdout,
      kill() {
        killed.push(config.name);
        try { ctrl.close(); } catch {}
      },
    };
    return proc;
  };
}

const cfg = (name: string): McpServerConfig => ({ name, command: "fake" }) as McpServerConfig;

describe("MCP handshake timeouts", () => {
  it("rejects connect() when the server never answers initialize", async () => {
    const killed: string[] = [];
    const client = new McpClient(cfg("hung"), { timeoutSeconds: 0.05 }, spawner(() => false, killed));
    const start = Date.now();
    const err = await client.connect().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolTimeoutError);
    expect(String((err as Error).message)).toContain("initialize");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(client.readiness).toBe("unready");
    expect(killed).toEqual(["hung"]);
  });

  it("rejects connect() when the server never answers tools/list", async () => {
    const client = new McpClient(
      cfg("nolist"),
      { timeoutSeconds: 0.05 },
      spawner((_n, m) => m === "initialize"),
    );
    await expect(client.connect()).rejects.toThrow("tools/list");
    expect(client.readiness).toBe("unready");
  });

  it("still connects normally when the server answers in time", async () => {
    const client = new McpClient(cfg("ok"), { timeoutSeconds: 0.05 }, spawner(() => true));
    await client.connect();
    expect(client.readiness).toBe("initialized");
    expect(client.listTools().map((t) => t.name)).toEqual(["ok_tool"]);
    client.close();
  });

  it("gateway startup is not blocked by a hung server; healthy servers still register", async () => {
    const gw = new Gateway({
      strategy: { mode: "single" },
      targets: [{ name: "a", provider: "openai", apiKey: "sk-test", baseURL: "http://localhost:1/v1" }],
      mcpServers: [
        { name: "hung", command: "fake", timeoutSeconds: 0.1 },
        { name: "good", command: "fake", timeoutSeconds: 0.1 },
      ],
    } as never);
    (gw as unknown as { mcpRegistry: McpRegistry }).mcpRegistry = new McpRegistry(
      spawner((name) => name !== "hung"),
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const start = Date.now();
      const outcome = await Promise.race([
        gw.initMcp().then(() => "done"),
        new Promise((r) => setTimeout(() => r("hung"), 2000)),
      ]);
      expect(outcome).toBe("done");
      expect(Date.now() - start).toBeLessThan(1000);
      expect(gw.mcpReadiness()).toEqual({ good: "initialized" });
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('"hung"'))).toBe(true);
    } finally {
      errSpy.mockRestore();
      gw.close();
    }
  });
});
