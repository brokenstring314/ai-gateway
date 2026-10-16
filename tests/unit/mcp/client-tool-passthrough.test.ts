import { describe, expect, it } from "bun:test";
import { McpExecutor } from "@/mcp";
import type { McpTool, McpToolRegistry } from "@/mcp";
import { Gateway } from "@/gateway";
import type { ChatCompletionRequest, ChatCompletionResponse, RequestContext } from "@/providers/types";
import type { IStrategy } from "@/routing/types";

const mcpTool: McpTool = { name: "mcp_search", description: "search", inputSchema: { type: "object" } } as McpTool;

function registry(calls: string[]): McpToolRegistry {
  const client = {
    listTools: () => [mcpTool],
    callTool: async (name: string) => {
      calls.push(name);
      return `ok:${name}`;
    },
  };
  return { allTools: () => [mcpTool], serverNames: () => ["srv"], getClient: () => client } as McpToolRegistry;
}

function toolResponse(...names: string[]): ChatCompletionResponse {
  return {
    id: "r", object: "chat.completion", created: 0, model: "m", provider: "a",
    choices: [{
      index: 0, finishReason: "tool_calls",
      message: {
        role: "assistant", content: null,
        toolCalls: names.map((name, i) => ({ id: `call_${i}`, type: "function" as const, function: { name, arguments: "{}" } })),
      },
    }],
  } as ChatCompletionResponse;
}

function countingStrategy(): { strategy: IStrategy; calls: () => number } {
  let n = 0;
  const strategy = {
    mode: "single",
    execute: async () => {
      n++;
      return { ...toolResponse(), choices: [{ index: 0, finishReason: "stop", message: { role: "assistant", content: "done" } }] } as ChatCompletionResponse;
    },
    executeStream: async function* () {},
    selectTargets: () => ["a"],
  } as unknown as IStrategy;
  return { strategy, calls: () => n };
}

const ctx: RequestContext = { metadata: {} } as RequestContext;
const baseReq: ChatCompletionRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

describe("McpExecutor leaves client-owned tool calls alone", () => {
  it("returns the response unchanged when the caller supplied its own tools", async () => {
    const toolCalls: string[] = [];
    const executor = new McpExecutor(registry(toolCalls));
    const req: ChatCompletionRequest = {
      ...baseReq,
      tools: [{ type: "function", function: { name: "client_weather", parameters: {} } }],
    };
    const injected = executor.injectTools(req);
    expect(injected).toBe(req);
    const { strategy, calls } = countingStrategy();
    const resp = toolResponse("client_weather");
    const out = await executor.executeAgenticLoop(ctx, injected, resp, strategy);
    expect(out).toBe(resp);
    expect(calls()).toBe(0);
    expect(toolCalls).toEqual([]);
  });

  it("does not hijack caller tools even when one shares an MCP tool name", async () => {
    const toolCalls: string[] = [];
    const executor = new McpExecutor(registry(toolCalls));
    const req: ChatCompletionRequest = {
      ...baseReq,
      tools: [{ type: "function", function: { name: "mcp_search", parameters: {} } }],
    };
    const { strategy, calls } = countingStrategy();
    const resp = toolResponse("mcp_search");
    expect(await executor.executeAgenticLoop(ctx, executor.injectTools(req), resp, strategy)).toBe(resp);
    expect(calls()).toBe(0);
    expect(toolCalls).toEqual([]);
  });

  it("returns the response unchanged if any tool_call is not an MCP tool", async () => {
    const toolCalls: string[] = [];
    const executor = new McpExecutor(registry(toolCalls));
    const { strategy, calls } = countingStrategy();
    const resp = toolResponse("mcp_search", "unknown_tool");
    const out = await executor.executeAgenticLoop(ctx, executor.injectTools(baseReq), resp, strategy);
    expect(out).toBe(resp);
    expect(calls()).toBe(0);
    expect(toolCalls).toEqual([]);
  });

  it("still runs the loop for MCP tool calls on injected requests", async () => {
    const toolCalls: string[] = [];
    const executor = new McpExecutor(registry(toolCalls));
    const { strategy, calls } = countingStrategy();
    const out = await executor.executeAgenticLoop(ctx, executor.injectTools(baseReq), toolResponse("mcp_search"), strategy);
    expect(out.choices[0]?.message?.content).toBe("done");
    expect(calls()).toBe(1);
    expect(toolCalls).toEqual(["mcp_search"]);
  });
});

describe("Gateway.route with caller-supplied tools", () => {
  it("returns the caller's tool_calls to the client instead of looping", async () => {
    const gw = new Gateway({
      strategy: { mode: "single" },
      targets: [{ name: "a", provider: "openai", apiKey: "sk-test", baseURL: "http://localhost:1/v1" }],
      mcpServers: [{ name: "srv", command: "fake" }],
    } as never);
    const g = gw as unknown as Record<string, unknown>;
    g["executeWithCircuitBreaker"] = async () => toolResponse("client_weather");
    const { strategy, calls } = countingStrategy();
    g["strategy"] = strategy;
    const out = await gw.route({ traceId: "t" } as RequestContext, {
      ...baseReq,
      tools: [{ type: "function", function: { name: "client_weather", parameters: {} } }],
    });
    expect(calls()).toBe(0);
    expect(out.choices[0]?.message?.toolCalls?.[0]?.function.name).toBe("client_weather");
  });
});
