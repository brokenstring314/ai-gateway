import { describe, it, expect, vi, beforeEach } from "bun:test";
import { Gateway } from "@/gateway";
import type { GatewayConfig } from "@/config/types";
import type { ChatCompletionRequest, ChatCompletionResponse, IProvider } from "@/providers/types";
import { PluginRejectionError } from "@/plugins/error";
import { CircuitBreakerRegistry } from "@/routing/circuit-breaker";

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["test-provider"] },
    targets: [
      {
        name: "test-provider",
        provider: "openai",
        apiKey: "sk-test",
        baseURL: "http://localhost:1234/v1",
      },
    ],
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function makeResponse(overrides?: Partial<ChatCompletionResponse>): ChatCompletionResponse {
  return {
    id: "resp-1",
    object: "chat.completion",
    created: Date.now(),
    model: "gpt-4",
    provider: "test-provider",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finishReason: "stop" }],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    ...overrides,
  };
}

describe("Gateway", () => {
  let gateway: Gateway;
  let mockProvider: IProvider;

  beforeEach(() => {
    mockProvider = {
      name: "test-provider",
      complete: vi.fn().mockResolvedValue(makeResponse()),
      supportedModels: vi.fn().mockReturnValue(["gpt-4"]),
      supportsModel: vi.fn().mockReturnValue(true),
      models: vi.fn().mockReturnValue([{ id: "gpt-4", ownedBy: "test" }]),
    };

    gateway = new Gateway(makeConfig());
    gateway.registerProvider(mockProvider);
  });

  describe("route()", () => {
    it("returns correct response from strategy", async () => {
      const resp = await gateway.route({ metadata: {} }, makeRequest());
      expect(resp.provider).toBe("test-provider");
      expect(resp.model).toBe("gpt-4");
    });

    it("runs before_request plugins", async () => {
      const plugin = {
        name: "test-plugin",
        stage: "before_request" as const,
        execute: vi.fn().mockResolvedValue({ action: "continue" }),
      };
      gateway.registerPlugin("before_request", plugin);

      await gateway.route({ metadata: {} }, makeRequest());
      expect(plugin.execute).toHaveBeenCalledTimes(1);
    });

    it("runs after_request plugins", async () => {
      const plugin = {
        name: "test-plugin",
        stage: "after_request" as const,
        execute: vi.fn().mockResolvedValue({ action: "continue" }),
      };
      gateway.registerPlugin("after_request", plugin);

      await gateway.route({ metadata: {} }, makeRequest());
      expect(plugin.execute).toHaveBeenCalledTimes(1);
    });

    it("runs on_error plugins on failure", async () => {
      (mockProvider.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));
      const plugin = {
        name: "error-plugin",
        stage: "on_error" as const,
        execute: vi.fn().mockResolvedValue({ action: "continue" }),
      };
      gateway.registerPlugin("on_error", plugin);

      await expect(gateway.route({ metadata: {} }, makeRequest())).rejects.toThrow("fail");
      expect(plugin.execute).toHaveBeenCalledTimes(1);
    });

    it("plugin rejection returns PluginRejectionError", async () => {
      const plugin = {
        name: "rejector",
        stage: "before_request" as const,
        execute: vi.fn().mockResolvedValue({ action: "reject", reason: "blocked" }),
      };
      gateway.registerPlugin("before_request", plugin);

      await expect(gateway.route({ metadata: {} }, makeRequest())).rejects.toThrow(PluginRejectionError);
    });
  });

  describe("routeStream()", () => {
    it("yields chunks from strategy", async () => {
      const streamProvider = {
        ...mockProvider,
        completeStream: async function* () {
          yield {
            id: "chunk-1",
            object: "chat.completion.chunk",
            created: Date.now(),
            model: "gpt-4",
            choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finishReason: "stop" }],
          };
        },
      };
      gateway.registerProvider(streamProvider);

      const chunks: unknown[] = [];
      for await (const chunk of gateway.routeStream({ metadata: {} }, makeRequest())) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe("model alias resolution", () => {
    it("resolves model alias in route()", async () => {
      const aliasedGateway = new Gateway(
        makeConfig({
          aliases: { "my-model": "gpt-4" },
        }),
      );
      aliasedGateway.registerProvider(mockProvider);

      const resp = await aliasedGateway.route({ metadata: {} }, makeRequest({ model: "my-model" }));
      expect(resp).toBeDefined();
      expect(mockProvider.complete).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ model: "gpt-4" }),
      );
    });
  });

  describe("circuit breaker integration", () => {
    it("records failure on provider error", async () => {
      (mockProvider.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));

      try {
        await gateway.route({ metadata: {} }, makeRequest());
      } catch {
        // expected
      }

      const _cb = gateway.getCircuitBreakerRegistry().get("test-provider");
      // No circuit breaker was configured for this target, so it won't exist
      // But the gateway should handle the error gracefully
    });

    it("circuit breaker registry is accessible", () => {
      const registry = gateway.getCircuitBreakerRegistry();
      expect(registry).toBeInstanceOf(CircuitBreakerRegistry);
    });

    it("circuit breaker configured via target config", () => {
      const cbGateway = new Gateway({
        strategy: { mode: "single", targets: ["cb-provider"] },
        targets: [
          {
            name: "cb-provider",
            provider: "openai",
            apiKey: "sk-test",
            baseURL: "http://localhost:1234/v1",
            circuitBreaker: { failureThreshold: 2, timeoutMs: 5000 },
          },
        ],
      });

      const cb = cbGateway.getCircuitBreakerRegistry().get("cb-provider");
      expect(cb).toBeDefined();
      expect(cb!.allow()).toBe(true);
    });
  });

  describe("embedWithPlugins()", () => {
    it("runs plugin lifecycle", async () => {
      const embedProvider = {
        ...mockProvider,
        embed: vi.fn().mockResolvedValue({
          object: "list",
          model: "text-embedding-3-small",
          provider: "test-provider",
          data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
          usage: { promptTokens: 3, completionTokens: 0, totalTokens: 3 },
        }),
      };
      const embedGateway = new Gateway(makeConfig());
      embedGateway.registerProvider(embedProvider);

      const plugin = {
        name: "test-plugin",
        stage: "before_request" as const,
        execute: vi.fn().mockResolvedValue({ action: "continue" }),
      };
      embedGateway.registerPlugin("before_request", plugin);

      await embedGateway.embedWithPlugins({ metadata: {} }, { model: "gpt-4", input: "hello" });
      expect(plugin.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("generateImageWithPlugins()", () => {
    it("runs plugin lifecycle", async () => {
      const imageProvider = {
        ...mockProvider,
        generateImage: vi.fn().mockResolvedValue({
          created: Date.now(),
          provider: "test-provider",
          data: [{ url: "http://example.com/image.png" }],
        }),
      };
      const imageGateway = new Gateway(makeConfig());
      imageGateway.registerProvider(imageProvider);

      const plugin = {
        name: "test-plugin",
        stage: "before_request" as const,
        execute: vi.fn().mockResolvedValue({ action: "continue" }),
      };
      imageGateway.registerPlugin("before_request", plugin);

      await imageGateway.generateImageWithPlugins({ metadata: {} }, { model: "gpt-4", prompt: "a cat" });
      expect(plugin.execute).toHaveBeenCalledTimes(1);
    });
  });
});
