// Shared helpers for plugin repros. Run from repo: cd /tmp/agw-plug && bun test <this dir>
import type { GatewayConfig } from "@/config/types";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  IProvider,
  RequestContext,
  StreamChunk,
} from "@/providers/types";

export function cfg(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    // These app-level tests exercise routing/plugins, not client auth.
    auth: { enabled: false },
    strategy: { mode: "single", targets: ["mock"] },
    targets: [{ name: "mock", provider: "openai", apiKey: "sk", baseURL: "https://up.example/v1", models: ["gpt-4o"] }],
    ...extra,
  } as GatewayConfig;
}

export interface Calls {
  chat: ChatCompletionRequest[];
  embed: unknown[];
  image: unknown[];
}
export function mockProvider(calls: Calls): IProvider {
  return {
    name: "mock",
    async complete(_c: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      calls.chat.push(req);
      return {
        id: "x",
        object: "chat.completion",
        created: 1,
        model: req.model,
        provider: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }],
        usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
      } as ChatCompletionResponse;
    },
    async *completeStream(_c: RequestContext, req: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
      calls.chat.push(req);
      yield {
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: req.model,
        choices: [{ index: 0, delta: { content: "hi" }, finishReason: "stop" }],
        usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
      } as unknown as StreamChunk;
    },
    async embed(_c: RequestContext, req: unknown) {
      calls.embed.push(req);
      return {
        object: "list",
        model: "gpt-4o",
        data: [{ object: "embedding", index: 0, embedding: [0.1] }],
        usage: { promptTokens: 1, totalTokens: 1 },
      };
    },
    async generateImage(_c: RequestContext, req: unknown) {
      calls.image.push(req);
      return { created: 1, data: [{ url: "https://img.example/x.png" }] };
    },
    supportedModels: () => ["gpt-4o"],
    supportsModel: (m: string) => m === "gpt-4o",
    models: () => [{ id: "gpt-4o", ownedBy: "mock" }],
  } as unknown as IProvider;
}
export const newCalls = (): Calls => ({ chat: [], embed: [], image: [] });
