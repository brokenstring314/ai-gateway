/**
 * MCP agentic loop (refactor plan §1.1 step 6, PR 2.7).
 *
 * After a non-streaming chat response whose tool_calls all target
 * gateway-injected MCP tools, run the tools and call the model again —
 * every round through the pipeline's executor (breaker, limiter, retry,
 * failover) — until a response without gateway-owned tool_calls.
 *
 *  - usage is summed over every upstream call the loop made (M3);
 *  - exceeding the depth budget throws McpCallDepthError, a GatewayError
 *    (502, code mcp_depth_exceeded) that the pipeline finalizes and logs
 *    like any other failure (M2).
 */

import { McpCallDepthError, type McpExecutor } from "../mcp/executor.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  RequestContext,
  ToolCall,
  Usage,
} from "../providers/types.js";
import { addUsage } from "./usage.js";

export type NextCompletion = (ctx: RequestContext, req: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

export interface McpLoopResult {
  readonly response: ChatCompletionResponse;
  /** Usage summed over the first response and every loop round. */
  readonly usage: Usage | undefined;
  /** Model calls made by the loop (not counting the first response). */
  readonly rounds: number;
}

export interface McpLoop {
  inject(req: ChatCompletionRequest): ChatCompletionRequest;
  run(ctx: RequestContext, req: ChatCompletionRequest, first: ChatCompletionResponse, next: NextCompletion): Promise<McpLoopResult>;
}

function toolCallsOf(response: ChatCompletionResponse): readonly ToolCall[] {
  return response.choices[0]?.message?.toolCalls ?? [];
}

export async function runMcpLoop(
  mcp: McpExecutor,
  ctx: RequestContext,
  req: ChatCompletionRequest,
  first: ChatCompletionResponse,
  next: NextCompletion,
): Promise<McpLoopResult> {
  let current = first;
  let usage: Usage | undefined = first.usage;
  let messages: ChatMessage[] = [...req.messages];
  let depth = 0;

  while (true) {
    const toolCalls = toolCallsOf(current);
    if (toolCalls.length === 0) break;
    // Client-owned tool calls are handed back to the client untouched.
    if (!mcp.shouldHandle(req, current)) break;
    if (depth >= mcp.maxDepth) throw new McpCallDepthError(mcp.maxDepth);

    messages = [...messages, { role: "assistant", content: current.choices[0]?.message?.content, toolCalls }];
    const results = await mcp.executeToolCalls(toolCalls);
    messages = [
      ...messages,
      ...results.map((r): ChatMessage => ({ role: "tool", content: r.content, toolCallId: r.toolCallId })),
    ];
    // Keep the injected tools so the model can make further calls.
    current = await next(ctx, { ...req, messages, tools: req.tools });
    usage = addUsage(usage, current.usage);
    depth++;
  }

  const response = usage !== undefined && depth > 0 ? { ...current, usage } : current;
  return { response, usage, rounds: depth };
}

/** The pipeline's MCP hook, backed by an McpExecutor (tool injection + tool calls). */
export function mcpLoop(mcp: McpExecutor): McpLoop {
  return {
    inject: (req) => mcp.injectTools(req),
    run: (ctx, req, first, next) => runMcpLoop(mcp, ctx, req, first, next),
  };
}
