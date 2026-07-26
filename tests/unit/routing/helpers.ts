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
