/**
 * Agentic tool-call executor — drives the MCP agentic loop.
 *
 * When MCP tools are configured:
 * 1. Inject MCP tool definitions into the request (if caller didn't send their own tools)
 * 2. After getting a response with tool_calls, execute each via the matching MCP server
 * 3. Build a new message with tool results and send the augmented conversation back
 * 4. Repeat until no more tool_calls or depth limit reached
 */

import type {
  RequestContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ToolDefinition,
  ToolCall,
} from "../providers/types.js";
import type { IStrategy } from "../routing/types.js";
import type { McpToolResult, McpToolRegistry } from "./types.js";

export const DEFAULT_MAX_CALL_DEPTH = 5;

/** Stable error thrown when the agentic loop exceeds its tool-call depth budget. */
export class McpCallDepthError extends Error {
  constructor(limit: number) {
    super(`MCP tool call depth exceeded limit of ${limit}`);
    this.name = "McpCallDepthError";
  }
}

export class McpExecutor {
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

    return { ...req, tools };
  }

  /**
   * Execute the agentic loop.
   *
   * Given an initial response that may contain tool_calls:
   * - Execute each tool call via the matching MCP server
   * - Append tool results as messages
   * - Re-invoke the strategy to get the next response
   * - Repeat until no tool_calls, or throw McpCallDepthError when the
   *   configured depth limit is exceeded
   *
   * Returns the final response (one without tool_calls).
   */
  async executeAgenticLoop(
    ctx: RequestContext,
    req: ChatCompletionRequest,
    response: ChatCompletionResponse,
    strategy: IStrategy,
  ): Promise<ChatCompletionResponse> {
    let currentResponse = response;
    let messages = [...req.messages];
    // Each independent request starts its agentic loop at depth 0.
    let depth = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const toolCalls = this.extractToolCalls(currentResponse);
      if (toolCalls.length === 0) break;

      if (depth >= this.maxCallDepth) {
        throw new McpCallDepthError(this.maxCallDepth);
      }

      // Append the assistant message with tool_calls
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: currentResponse.choices[0]?.message?.content,
        toolCalls,
      };
      messages = [...messages, assistantMessage];

      // Execute each tool call and collect results
      const toolResults = await this.executeToolCalls(toolCalls);

      // Append tool result messages
      const toolMessages: ChatMessage[] = toolResults.map((result) => ({
        role: "tool" as const,
        content: result.content,
        toolCallId: result.toolCallId,
      }));
      messages = [...messages, ...toolMessages];

      // Build next request with augmented conversation
      const nextReq: ChatCompletionRequest = {
        ...req,
        messages,
        // Keep the injected tools so the LLM can make further calls
        tools: req.tools,
      };

      // Re-invoke the strategy
      currentResponse = await strategy.execute(ctx, nextReq);
      depth++;
    }

    return currentResponse;
  }

  /** Extract tool_calls from the first choice of a response. */
  private extractToolCalls(response: ChatCompletionResponse): readonly ToolCall[] {
    const message = response.choices[0]?.message;
    if (!message?.toolCalls || message.toolCalls.length === 0) return [];
    return message.toolCalls;
  }

  /** Execute a batch of tool calls, returning results for each. */
  private async executeToolCalls(toolCalls: readonly ToolCall[]): Promise<McpToolResult[]> {
    const results = await Promise.all(
      toolCalls.map(async (call) => this.executeSingleToolCall(call)),
    );
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
