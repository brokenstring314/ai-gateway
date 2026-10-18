// B3-10 regression: a crashed (or never-started) MCP stdio server is
// reconnected with exponential backoff, each step is logged, and a required
// server that keeps failing makes /livez fail instead of leaving a zombie pod.
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { McpRegistry } from "@/mcp";
import type { McpServerConfig, McpSpawner, McpSubprocess } from "@/mcp";
import { registerLivenessHandler } from "@/handlers/health";
import type { AppType } from "@/app";
import type { Gateway } from "@/gateway";

type Mode = "ok" | "dead";

interface FakeServer {
  subprocess: McpSubprocess;
  crash(): void;
}

function fakeServer(mode: Mode): FakeServer {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const close = () => {
    if (closed) return;
    closed = true;
    controller.close();
  };
  const respond = (id: number, result: unknown) =>
    controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`));
  const subprocess: McpSubprocess = {
    stdin: {
      write(data: string) {
        if (mode === "dead" || closed) return;
        for (const line of data.split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (typeof msg.id !== "number") continue;
          if (msg.method === "initialize")
            respond(msg.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "f" } });
          if (msg.method === "tools/list") respond(msg.id, { tools: [{ name: "t1" }] });
        }
      },
    },
    stdout,
    kill: close,
  };
  if (mode === "dead") queueMicrotask(close);
  return { subprocess, crash: close };
}

function harness(modes: () => Mode) {
  const spawned: FakeServer[] = [];
  const spawner: McpSpawner = (_c: McpServerConfig) => {
    const s = fakeServer(modes());
    spawned.push(s);
    return s.subprocess;
  };
  const logs: string[] = [];
  return { spawner, spawned, logs, log: (_l: string, m: string) => logs.push(m) };
}

const cfg = (name: string): McpServerConfig => ({ name, command: "fake", timeoutSeconds: 1 });

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("B3-10 MCP crash restart", () => {
  it("respawns a crashed server and its tools come back; disconnect and reconnect are logged", async () => {
    const h = harness(() => "ok");
    const registry = new McpRegistry(h.spawner, { initialDelayMs: 5 }, h.log);
    try {
      await registry.addServer(cfg("crashy"), { required: true });
      expect(registry.allTools().map((t) => t.name)).toEqual(["t1"]);
      h.spawned[0]?.crash();
      await waitFor(() => registry.readiness("crashy") === "unready");
      await waitFor(() => registry.readiness("crashy") === "initialized");
      expect(h.spawned.length).toBe(2);
      expect(registry.allTools().map((t) => t.name)).toEqual(["t1"]);
      expect(registry.requiredServersReady()).toBe(true);
      expect(h.logs.some((m) => m.includes('"crashy" disconnected'))).toBe(true);
      expect(h.logs.some((m) => m.includes('"crashy" reconnected'))).toBe(true);
    } finally {
      registry.closeAll();
    }
  });

  it("retries a server that fails at startup with exponential backoff until it comes up", async () => {
    let n = 0;
    const h = harness(() => (++n <= 3 ? "dead" : "ok"));
    const registry = new McpRegistry(h.spawner, { initialDelayMs: 4, multiplier: 2, maxDelayMs: 10 }, h.log);
    try {
      await expect(registry.addServer(cfg("late"))).rejects.toThrow();
      expect(registry.readiness("late")).toBe("unready");
      await waitFor(() => registry.readiness("late") === "initialized");
      expect(h.spawned.length).toBe(4);
      expect(registry.consecutiveFailures("late")).toBe(0);
      const delays = h.logs
        .map((m) => /reconnect attempt \d+ in (\d+)ms/.exec(m)?.[1])
        .filter((d): d is string => d !== undefined)
        .map(Number);
      expect(delays).toEqual([4, 8, 10]); // doubled, capped at maxDelayMs
    } finally {
      registry.closeAll();
    }
  });

  it("a required server that keeps failing fails /livez after the threshold", async () => {
    const h = harness(() => "dead");
    const registry = new McpRegistry(
      h.spawner,
      { initialDelayMs: 1, maxDelayMs: 2, livenessFailureThreshold: 3 },
      h.log,
    );
    const app = new Hono() as unknown as AppType;
    registerLivenessHandler(app, { isMcpLive: () => registry.requiredServersLive() } as unknown as Gateway);
    try {
      await expect(registry.addServer(cfg("req"), { required: true })).rejects.toThrow();
      expect((await app.request("/livez")).status).toBe(200);
      await waitFor(() => registry.consecutiveFailures("req") >= 3);
      expect(registry.requiredServersLive()).toBe(false);
      expect((await app.request("/livez")).status).toBe(503);
      expect(h.logs.some((m) => m.includes("/livez now reports failure"))).toBe(true);
    } finally {
      registry.closeAll();
    }
  });

  it("an optional server that keeps failing never fails liveness", async () => {
    const h = harness(() => "dead");
    const registry = new McpRegistry(
      h.spawner,
      { initialDelayMs: 1, maxDelayMs: 1, livenessFailureThreshold: 2 },
      h.log,
    );
    try {
      await expect(registry.addServer(cfg("opt"))).rejects.toThrow();
      await waitFor(() => registry.consecutiveFailures("opt") >= 3);
      expect(registry.requiredServersLive()).toBe(true);
    } finally {
      registry.closeAll();
    }
  });

  it("closeAll stops reconnecting", async () => {
    const h = harness(() => "dead");
    const registry = new McpRegistry(h.spawner, { initialDelayMs: 5 }, h.log);
    await expect(registry.addServer(cfg("x"))).rejects.toThrow();
    registry.closeAll();
    const count = h.spawned.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(h.spawned.length).toBe(count);
  });
});
