/**
 * Agentic tool-call executor — drives the MCP agentic loop.
 *
 * When MCP tools are configured:
 * 1. Inject MCP tool definitions into the request (if caller didn't send their own tools)
 * 2. After getting a response with tool_calls, execute each via the matching MCP server
 *    — only when the tools were injected by the gateway and every call is an MCP tool;
 *    otherwise the response is returned to the client unchanged
 * 3. Build a new message with tool results and send the augmented conversation back
 * 4. Repeat until no more tool_calls or depth limit reached
 */

import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolDefinition,
  ToolCall,
} from "../providers/types.js";
import type { McpToolResult, McpToolRegistry } from "./types.js";
import { GatewayError } from "../core/errors.js";
import { runMcpLoop } from "../core/mcp-loop.js";

/** How the agentic loop makes its next model call: a function, or any object with execute(). */
export type ChatCompleter =
  | ((ctx: RequestContext, req: ChatCompletionRequest) => Promise<ChatCompletionResponse>)
  | { execute(ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> };

export const DEFAULT_MAX_CALL_DEPTH = 5;

/**
 * Stable error thrown when the agentic loop exceeds its tool-call depth
 * budget. A GatewayError: answered 502 `mcp_depth_exceeded` (was a bare
 * Error → 500 "Internal server error").
 */
export class McpCallDepthError extends GatewayError {
  override name = "McpCallDepthError";
  readonly limit: number;
  constructor(limit: number) {
    super("internal", {
      status: 502,
      message: `MCP tool call depth exceeded limit of ${limit}`,
      type: "server_error",
      code: "mcp_depth_exceeded",
    });
    this.limit = limit;
  }
}

export class McpExecutor {
  /** Requests whose `tools` were injected by this executor (vs. supplied by the caller). */
  private readonly injectedRequests = new WeakSet<ChatCompletionRequest>();

  constructor(
    private readonly registry: McpToolRegistry,
    private readonly maxCallDepth: number = DEFAULT_MAX_CALL_DEPTH,
  ) {}

  /**
   * Inject MCP tool definitions into a request if the caller didn't provide their own.
   * Returns a new request with tools appended (or the original if no MCP tools or caller has tools).
   */
  injectTools(req: ChatCompletionRequest): ChatCompletionRequest {
    // Don't inject if caller already specified tools — avoid conflicts
    if (req.tools && req.tools.length > 0) return req;

    const mcpTools = this.registry.allTools();
    if (mcpTools.length === 0) return req;

    const tools: ToolDefinition[] = mcpTools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const injected: ChatCompletionRequest = { ...req, tools };
    this.injectedRequests.add(injected);
    return injected;
  }

  /**
   * Whether the gateway should run the agentic loop for this request/response:
   * only when the request's tools are not caller-supplied and every tool_call
   * targets a tool owned by an MCP server. Otherwise the tool_calls belong to
   * the client and the response must be returned to it unchanged.
   */
  shouldHandle(req: ChatCompletionRequest, response: ChatCompletionResponse): boolean {
    const toolCalls = this.extractToolCalls(response);
    if (toolCalls.length === 0) return false;
    if (req.tools && req.tools.length > 0 && !this.injectedRequests.has(req)) return false;
    const mcpToolNames = new Set(this.registry.allTools().map((t) => t.name));
    return toolCalls.every((call) => mcpToolNames.has(call.function.name));
  }

  /**
   * Execute the agentic loop.
   *
   * Given an initial response that may contain tool_calls:
   * - Execute each tool call via the matching MCP server
   * - Append tool results as messages
   * - Call the model again (via `next`) to get the next response
   * - Repeat until no tool_calls, or throw McpCallDepthError when the
   *   configured depth limit is exceeded
   *
   * Returns the final response (one without tool_calls).
   */
  async executeAgenticLoop(
    ctx: RequestContext,
    req: ChatCompletionRequest,
    response: ChatCompletionResponse,
    next: ChatCompleter,
  ): Promise<ChatCompletionResponse> {
    const complete =
      typeof next === "function" ? next : (c: RequestContext, r: ChatCompletionRequest) => next.execute(c, r);
    return (await runMcpLoop(this, ctx, req, response, complete)).response;
  }

  /** Tool-call depth budget of the agentic loop. */
  get maxDepth(): number {
    return this.maxCallDepth;
  }

  /** Extract tool_calls from the first choice of a response. */
  private extractToolCalls(response: ChatCompletionResponse): readonly ToolCall[] {
    const message = response.choices[0]?.message;
    if (!message?.toolCalls || message.toolCalls.length === 0) return [];
    return message.toolCalls;
  }

  /** Execute a batch of tool calls, returning results for each. */
  async executeToolCalls(toolCalls: readonly ToolCall[]): Promise<McpToolResult[]> {
    const results = await Promise.all(toolCalls.map(async (call) => this.executeSingleToolCall(call)));
    return results;
  }

  /** Execute a single tool call by finding the matching MCP server. */
  private async executeSingleToolCall(call: ToolCall): Promise<McpToolResult> {
    const toolName = call.function.name;

    // Find which server owns this tool
    for (const serverName of this.registry.serverNames()) {
      const client = this.registry.getClient(serverName);
      if (!client) continue;

      const serverTools = client.listTools();
      const hasTool = serverTools.some((t) => t.name === toolName);
      if (!hasTool) continue;

      try {
        const args = this.parseArguments(call.function.arguments);
        const content = await client.callTool(toolName, args);
        return { toolCallId: call.id, content, isError: false };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { toolCallId: call.id, content: message, isError: true };
      }
    }

    // No server owns this tool
    return {
      toolCallId: call.id,
      content: `No MCP server found for tool "${toolName}"`,
      isError: true,
    };
  }

  /** Parse JSON arguments string, falling back to empty object. */
  private parseArguments(argsStr: string): Record<string, unknown> {
    if (!argsStr || argsStr.trim().length === 0) return {};
    try {
      return JSON.parse(argsStr) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
