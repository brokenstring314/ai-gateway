/**
 * Shared test helpers for routing strategy tests.
 */

import type {
  IProvider,
  IStreamProvider,
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  RequestContext,
  ChatMessage,
} from "@/providers/types";

export function createReq(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "gpt-4",
    messages: [
      { role: "user", content: "Hello, world!" } as ChatMessage,
    ],
    ...overrides,
  };
}

/**
 * Minimal mock provider with IProvider only (no streaming).
 */
export function createMockProvider(name: string): IProvider {
  return {
    name,
    complete: async (
      _ctx: RequestContext,
      req: ChatCompletionRequest,
    ): Promise<ChatCompletionResponse> => ({
      id: `resp-${name}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      provider: name,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: `Hello from ${name}` },
          finishReason: "stop",
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    }),
    supportedModels: () => [],
    supportsModel: () => true,
    models: () => [],
  };
}

/**
 * Minimal mock provider implementing IStreamProvider.
 */
export function createStreamMockProvider(name: string): IProvider & IStreamProvider {
  return {
    ...createMockProvider(name),
    completeStream: async function* (
      _ctx: RequestContext,
      req: ChatCompletionRequest,
    ): AsyncIterable<StreamChunk> {
      yield {
        id: `chunk-${name}-1`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: `Hello from ${name}` },
            finishReason: "stop",
          },
        ],
      };
    },
  };
}

/**
 * Provider whose complete() throws the given error (for fallback tests).
 */
export function createFailingProvider(
  name: string,
  error: Error,
): IProvider {
  return {
    ...createMockProvider(name),
    complete: async (): Promise<ChatCompletionResponse> => {
      throw error;
    },
  };
}

// ── Strategies bound to an executor (strategies only order targets since 2.2) ──

import { TargetExecutor, executeChat, streamChat } from "@/core/executor";
import type { IStrategy, ProviderLookup } from "@/routing/types";
import type { RetryConfig } from "@/config/types";
import { SingleStrategy } from "@/routing/single";
import { FallbackStrategy } from "@/routing/fallback";
import { LoadBalanceStrategy } from "@/routing/loadbalance";
import { ConditionalStrategy } from "@/routing/conditional";

export type BoundStrategy<S extends IStrategy> = S & {
  execute(ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  executeStream(ctx: RequestContext, req: ChatCompletionRequest): AsyncGenerator<StreamChunk>;
};

/**
 * The strategy plus execute()/executeStream() through the shared executor
 * (failover, per-target retry), as the gateway runs it — without breakers
 * or limiters.
 */
export function bindStrategy<S extends IStrategy>(
  strategy: S,
  lookup: ProviderLookup,
  retryConfigs?: ReadonlyMap<string, RetryConfig>,
): BoundStrategy<S> {
  const executor = new TargetExecutor({ lookup, retryConfig: (n) => retryConfigs?.get(n) });
  const bound = Object.create(strategy) as BoundStrategy<S>;
  bound.execute = (ctx, req) => executeChat(executor, strategy, ctx, req);
  bound.executeStream = (ctx, req) => streamChat(executor, strategy, ctx, req);
  return bound;
}

type WithRetry<C> = C & { retryConfigs?: ReadonlyMap<string, RetryConfig> };

export const boundSingle = (lookup: ProviderLookup, config: ConstructorParameters<typeof SingleStrategy>[0]) =>
  bindStrategy(new SingleStrategy(config), lookup);
export const boundFallback = (lookup: ProviderLookup, config: WithRetry<ConstructorParameters<typeof FallbackStrategy>[0]>) =>
  bindStrategy(new FallbackStrategy(config), lookup, config.retryConfigs);
export const boundLoadBalance = (lookup: ProviderLookup, config: WithRetry<ConstructorParameters<typeof LoadBalanceStrategy>[0]>) =>
  bindStrategy(new LoadBalanceStrategy(config), lookup, config.retryConfigs);
export const boundConditional = (lookup: ProviderLookup, config: WithRetry<ConstructorParameters<typeof ConditionalStrategy>[0]>) =>
  bindStrategy(new ConditionalStrategy(config), lookup, config.retryConfigs);
