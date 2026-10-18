/**
 * Tests for MCP extensions: runtime options (allowedTools / maxCallDepth /
 * timeoutSeconds / required), transport inference, call-depth guard, tool-call
 * timeout, readiness tracking, and stdio process-death handling.
 *
 * The stdio subprocess is fully mocked (injected spawner + fake stream), so no
 * real npx services or bun subprocesses are required.
 */

import { describe, expect, it, } from "bun:test";
import {
  McpClient,
  McpRegistry,
  McpExecutor,
  McpCallDepthError,
  McpToolTimeoutError,
  DEFAULT_MAX_CALL_DEPTH,
  DEFAULT_TIMEOUT_SECONDS,
} from "@/mcp";
import type {
  McpServerConfig,
  McpServerOptions,
  McpSpawner,
  McpSubprocess,
  McpTool,
  McpToolCallTarget,
  McpToolRegistry,
} from "@/mcp";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  RequestContext,
} from "@/providers/types";
import type { IStrategy } from "@/routing/types";

async function waitFor(check: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw lastError;
}

// ── Mock stdio server ──

interface MockServerOptions {
  /** Never respond to initialize (connection stays in "connected" state). */
  hangOnInitialize?: boolean;
  /** Never respond to tools/call (call hangs until timeout). */
  hangOnCall?: boolean;
  /** Respond to initialize + tools/list, then close stdout right after. */
  exitAfterList?: boolean;
  /** Close stdout immediately without responding to anything. */
  exitImmediately?: boolean;
}

interface MockServer {
  subprocess: McpSubprocess;
  /** Raw JSON lines received from the client. */
  received: string[];
}

/** Fake stdio MCP server speaking the protocol subset over a controllable stream. */
function createMockServer(options: MockServerOptions = {}): MockServer {
  const received: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;

  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    controller.close();
  };

  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  function respond(id: number, result: unknown): void {
    controller.enqueue(
      new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"),
    );
  }

  function handleLine(line: string): void {
    if (options.exitImmediately) return;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    // Notifications (no numeric id) are ignored.
    if (typeof msg.id !== "number") return;

    if (msg.method === "initialize") {
      if (!options.hangOnInitialize) {
        respond(msg.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "mock" },
        });
      }
    } else if (msg.method === "tools/list") {
      respond(msg.id, {
        tools: [
          { name: "alpha", description: "mock tool", inputSchema: { type: "object" } },
          { name: "beta", description: "mock tool", inputSchema: { type: "object" } },
        ],
      });
      if (options.exitAfterList) {
        // Give the client time to process the response before the EOF arrives.
        setTimeout(() => closeStream(), 10);
      }
    } else if (msg.method === "tools/call") {
      if (!options.hangOnCall) {
        const name = String(msg.params?.["name"]);
        respond(msg.id, { content: [{ type: "text", text: `ok:${name}` }] });
      }
    }
  }

  const subprocess: McpSubprocess = {
    stdin: {
      write: (data: string) => {
        received.push(data);
        for (const line of data.split("\n")) {
          handleLine(line);
        }
      },
    },
    stdout,
    kill: () => {
      closeStream();
    },
  };

  if (options.exitImmediately) {
    closeStream();
  }

  return { subprocess, received };
}

/** A spawner that hands the client a fake server per config name. */
function makeSpawner(servers: Record<string, MockServerOptions> = {}): McpSpawner {
  return (config: McpServerConfig): McpSubprocess => {
    const server = createMockServer(servers[config.name] ?? {});
    return server.subprocess;
  };
}

/** A schema-shaped stdio config pointing at the mock server. */
function stdioConfig(name: string): McpServerConfig {
  return { name, type: "stdio", command: "mock-command", args: [] };
}

// ── Executor fixtures ──

const alphaTool: McpTool = {
  name: "alpha",
  description: "mock tool",
  inputSchema: { type: "object" },
};

function makeToolRegistry(): McpToolRegistry {
  const client: McpToolCallTarget = {
    listTools: () => [alphaTool],
    callTool: async (name: string) => `ok:${name}`,
  };
  return {
    allTools: () => [alphaTool],
    serverNames: () => ["mock"],
    getClient: () => client,
  };
}

function makeRequest(): ChatCompletionRequest {
  return { model: "test-model", messages: [{ role: "user", content: "hi" }] };
}

function ctx(): RequestContext {
  return { metadata: {} };
}

function responseWithToolCalls(id: string): ChatCompletionResponse {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model: "test-model",
    provider: "test",
    choices: [
      {
        index: 0,
        finishReason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "alpha", arguments: "{}" } },
          ],
        },
      },
    ],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function plainResponse(id: string): ChatCompletionResponse {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model: "test-model",
    provider: "test",
    choices: [
      {
        index: 0,
        finishReason: "stop",
        message: { role: "assistant", content: "done" },
      },
    ],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

/** Strategy that returns tool_calls for `rounds` calls, then a plain response. */
function toolCallingStrategy(rounds = Infinity): { strategy: IStrategy; callCount: () => number } {
  let calls = 0;
  const strategy: IStrategy = {
    mode: "single",
    execute: async (): Promise<ChatCompletionResponse> => {
      calls++;
      if (calls >= rounds) return plainResponse(`resp-${calls}`);
      return responseWithToolCalls(`resp-${calls}`);
    },
    executeStream: async function* () {},
    selectTargets: () => ["test"],
  };
  return { strategy, callCount: () => calls };
}

// ── Tests ──

describe("MCP transport inference", () => {
  it("infers stdio transport from command", async () => {
    const client = new McpClient(stdioConfig("inferred"), undefined, makeSpawner());
    await client.connect();
    expect(client.readiness).toBe("initialized");
    expect(client.listTools().map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
    client.close();
  });

  it("rejects url-based http transport as unsupported without spawning", async () => {
    const client = new McpClient(
      { name: "http-server", type: "http", url: "http://127.0.0.1:9999" },
      undefined,
      makeSpawner(),
    );
    await expect(client.connect()).rejects.toThrow(/http.*not supported/i);
    expect(client.readiness).toBe("unready");
  });

  it("requires either command or url", async () => {
    const client = new McpClient(
      { name: "neither", type: "stdio" },
      undefined,
      makeSpawner(),
    );
    await expect(client.connect()).rejects.toThrow(/requires either a command \(stdio\) or url/);
    expect(client.readiness).toBe("unready");
  });
});

describe("MCP allowedTools filtering", () => {
  it("exposes only whitelisted tools and rejects calls to others", async () => {
    const client = new McpClient(stdioConfig("whitelisted"), { allowedTools: ["alpha"] }, makeSpawner());
    await client.connect();
    expect(client.listTools().map((t) => t.name)).toEqual(["alpha"]);
    await expect(client.callTool("beta", {})).rejects.toThrow(/not allowed/);
    await expect(client.callTool("alpha", {})).resolves.toBe("ok:alpha");
    client.close();
  });

  it("exposes all tools when allowedTools is unset", async () => {
    const client = new McpClient(stdioConfig("all-tools"), undefined, makeSpawner());
    await client.connect();
    expect(client.listTools().map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
    client.close();
  });

  it("registry advertises only whitelisted tools", async () => {
    const registry = new McpRegistry(makeSpawner({ whitelisted: {} }));
    await registry.addServer(stdioConfig("whitelisted"), {
      allowedTools: ["alpha"],
    });
    expect(registry.allTools().map((t) => t.name)).toEqual(["alpha"]);
    registry.closeAll();
  });
});

describe("MCP tool-call timeout", () => {
  it("races hanging calls against an AbortSignal timeout with a stable error", async () => {
    const client = new McpClient(
      stdioConfig("slow"),
      { timeoutSeconds: 0.05 },
      makeSpawner({ slow: { hangOnCall: true } }),
    );
    await client.connect();
    expect(client.readiness).toBe("initialized");

    await expect(client.callTool("alpha", {})).rejects.toBeInstanceOf(McpToolTimeoutError);
    // The connection itself survives the timeout.
    expect(client.readiness).toBe("initialized");
    await expect(client.callTool("alpha", {})).rejects.toThrow(
      'MCP tool "alpha" timed out after 50ms',
    );

    client.close();
  });
});

describe("MCP readiness", () => {
  it("exposes connected state while the initialize handshake is pending", async () => {
    const client = new McpClient(
      stdioConfig("slow-init"),
      undefined,
      makeSpawner({ "slow-init": { hangOnInitialize: true } }),
    );
    const connecting = client.connect();
    await waitFor(() => expect(client.readiness).toBe("connected"));
    client.close();
    await expect(connecting).rejects.toThrow(/closed/);
  });

  it("tracks required server readiness across success and failure", async () => {
    const registry = new McpRegistry(
      makeSpawner({ good: {}, failing: { exitImmediately: true } }),
    );
    expect(registry.requiredServersReady()).toBe(true);

    await registry.addServer(stdioConfig("good"), { required: true });
    expect(registry.readiness("good")).toBe("initialized");
    expect(registry.requiredServersReady()).toBe(true);

    await expect(
      registry.addServer(stdioConfig("failing"), { required: true }),
    ).rejects.toThrow();
    expect(registry.readiness("failing")).toBe("unready");
    expect(registry.requiredServersReady()).toBe(false);

    registry.closeAll();
  });

  it("an optional server dying does not fail required readiness", async () => {
    const registry = new McpRegistry(
      makeSpawner({ req: {}, opt: { exitAfterList: true } }),
    );
    await registry.addServer(stdioConfig("req"), { required: true });
    const optional = await registry.addServer(stdioConfig("opt"));
    expect(registry.requiredServersReady()).toBe(true);

    await waitFor(() => expect(optional.readiness).toBe("unready"));

    expect(registry.requiredServersReady()).toBe(true);
    expect(registry.readiness("req")).toBe("initialized");
    // The required server's tools are still advertised.
    expect(registry.allTools().map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
    registry.closeAll();
  });

  it("stores runtime options per server", async () => {
    const registry = new McpRegistry(makeSpawner({ opts: {} }));
    const options: McpServerOptions = {
      allowedTools: ["alpha"],
      maxCallDepth: 3,
      timeoutSeconds: 9,
      required: true,
    };
    await registry.addServer(stdioConfig("opts"), options);
    expect(registry.getOptions("opts")).toEqual(options);
    registry.closeAll();
  });
});

describe("MCP stdio process death", () => {
  it("marks the client unready and stops advertising tools after exit", async () => {
    const registry = new McpRegistry(makeSpawner({ dying: { exitAfterList: true } }));
    const client = await registry.addServer(stdioConfig("dying"));
    expect(client.readiness).toBe("initialized");
    expect(client.listTools().map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
    expect(registry.allTools().map((t) => t.name).sort()).toEqual(["alpha", "beta"]);

    await waitFor(() => expect(client.readiness).toBe("unready"));

    expect(client.listTools()).toEqual([]);
    expect(registry.allTools()).toEqual([]);
    expect(registry.readiness("dying")).toBe("unready");
    expect(registry.requiredServersReady()).toBe(true);
    // Calls after death fail fast instead of hanging.
    await expect(client.callTool("alpha", {})).rejects.toThrow("not connected");

    registry.closeAll();
  });
});

describe("McpExecutor call-depth guard", () => {
  it("throws a stable error when the call-depth limit is exceeded", async () => {
    const { strategy, callCount } = toolCallingStrategy();
    const executor = new McpExecutor(makeToolRegistry(), 2);
    const error = await executor
      .executeAgenticLoop(ctx(), makeRequest(), responseWithToolCalls("resp-0"), strategy)
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(McpCallDepthError);
    expect(error).toMatchObject({
      name: "McpCallDepthError",
      message: "MCP tool call depth exceeded limit of 2",
    });
    expect(callCount()).toBe(2);
  });

  it("defaults the call-depth limit to 5", async () => {
    const { strategy, callCount } = toolCallingStrategy();
    const executor = new McpExecutor(makeToolRegistry());
    await expect(
      executor.executeAgenticLoop(ctx(), makeRequest(), responseWithToolCalls("resp-0"), strategy),
    ).rejects.toThrow("MCP tool call depth exceeded limit of 5");
    expect(callCount()).toBe(5);
  });

  it("completes within the limit when the model stops calling tools", async () => {
    const { strategy, callCount } = toolCallingStrategy(3);
    const executor = new McpExecutor(makeToolRegistry(), 5);
    const result = await executor.executeAgenticLoop(
      ctx(),
      makeRequest(),
      responseWithToolCalls("resp-0"),
      strategy,
    );
    expect(result.choices[0]?.message?.content).toBe("done");
    expect(callCount()).toBe(3);
  });

  it("starts each independent request at depth 0", async () => {
    const { strategy, callCount } = toolCallingStrategy();
    const executor = new McpExecutor(makeToolRegistry(), 2);

    await expect(
      executor.executeAgenticLoop(ctx(), makeRequest(), responseWithToolCalls("resp-0"), strategy),
    ).rejects.toThrow(McpCallDepthError);
    expect(callCount()).toBe(2);

    // A second request on the same executor must start from depth 0 again.
    await expect(
      executor.executeAgenticLoop(ctx(), makeRequest(), responseWithToolCalls("resp-1"), strategy),
    ).rejects.toThrow(McpCallDepthError);
    expect(callCount()).toBe(4);
  });
});

describe("MCP defaults", () => {
  it("exposes documented default constants", () => {
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(30);
    expect(DEFAULT_MAX_CALL_DEPTH).toBe(5);
  });
});
