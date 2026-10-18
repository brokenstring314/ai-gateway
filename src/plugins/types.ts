/**
 * Plugin system interfaces.
 */

import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.js";

export type Stage = "before_request" | "after_request" | "on_error";

export interface IPlugin {
  readonly name: string;
  readonly stage: Stage;
  execute(ctx: PluginContext): Promise<PluginResult>;
}

export interface PluginContext {
  request: ChatCompletionRequest;
  response?: ChatCompletionResponse;
  error?: Error;
  metadata: Record<string, unknown>;
  shortCircuit(response: ChatCompletionResponse): void;
}

export type PluginResult =
  | { action: "continue" }
  | { action: "short_circuit"; response: ChatCompletionResponse }
  /**
   * Block the request. `status` is the HTTP status answered (default 403;
   * the rate-limit and budget plugins use 429); `retryAfterSeconds` becomes
   * the Retry-After header.
   */
  | { action: "reject"; reason: string; status?: number; retryAfterSeconds?: number }
  | { action: "modify"; request?: ChatCompletionRequest; response?: ChatCompletionResponse };

export interface IPluginManager {
  register(stage: Stage, plugin: IPlugin): void;
  runBefore(ctx: PluginContext): Promise<void>;
  runAfter(ctx: PluginContext): Promise<void>;
  runOnError(ctx: PluginContext): Promise<void>;
  hasPlugins(): boolean;
}
