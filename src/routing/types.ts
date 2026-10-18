/**
 * Routing strategy interfaces.
 */

import type { IProvider, ChatCompletionRequest, ChatCompletionResponse, StreamChunk, RequestContext } from "../providers/types.js";

export type StrategyMode =
  | "single"
  | "fallback"
  | "loadbalance"
  | "conditional";

export interface IStrategy {
  readonly mode: StrategyMode;
  execute(ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  executeStream(ctx: RequestContext, req: ChatCompletionRequest): AsyncIterable<StreamChunk>;
  selectTargets(req: ChatCompletionRequest): string[];
}

export type ProviderLookup = (name: string) => IProvider | undefined;
