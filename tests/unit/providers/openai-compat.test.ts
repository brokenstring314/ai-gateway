/**
 * Unit tests for the OpenAI-compatible provider adapter.
 *
 * Verifies request building, response normalisation, error handling,
 * and capability enforcement — all via mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOpenAICompatProvider, ProviderError } from "@/providers/openai-compat";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@/providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

function makeProvider(overrides?: { name?: string; baseURL?: string; apiKey?: string; models?: string[] }) {
  return createOpenAICompatProvider({
    name: overrides?.name ?? "test-provider",
    baseURL: overrides?.baseURL ?? "https://api.example.com/v1",
    apiKey: overrides?.apiKey ?? "sk-test",
    models: overrides?.models ?? ["test-model"],
  });
}

function makeCtx() {
  return { metadata: {} };
}

function makeRequest(overrides?: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown, headers?: Record<string, string>) {
  const h = new Headers(headers);
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: h }),
  );
}

function mockFetchStream(chunks: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  fetchMock.mockResolvedValueOnce(
    new Response(stream, { status: 200 }),
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOpenAICompatProvider", () => {
  describe("basic properties", () => {
    it("returns the correct name", () => {
      const p = makeProvider({ name: "my-provider" });
      expect(p.name).toBe("my-provider");
    });

    it("returns supported models", () => {
      const p = makeProvider({ models: ["model-a", "model-b"] });
      expect(p.supportedModels()).toEqual(["model-a", "model-b"]);
    });

    it("checks supportsModel correctly", () => {
      const p = makeProvider({ models: ["model-a"] });
      expect(p.supportsModel("model-a")).toBe(true);
      expect(p.supportsModel("model-b")).toBe(false);
    });

    it("returns ModelInfo list", () => {
      const p = makeProvider({ models: ["model-a"] });
      const models = p.models();
      expect(models).toHaveLength(1);
      expect(models[0]!.id).toBe("model-a");
      expect(models[0]!.ownedBy).toBe("test-provider");
    });
  });

  describe("complete()", () => {
    it("builds a correct JSON request body", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });

      const p = makeProvider();
      await p.complete(makeCtx(), makeRequest());

      const call = fetchMock.mock.calls[0]!;
      const url = call[0] as string;
      const init = call[1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;

      expect(url).toBe("https://api.example.com/v1/chat/completions");
      expect(body["model"]).toBe("test-model");
      expect(Array.isArray(body["messages"])).toBe(true);
      expect((body["messages"] as Record<string, unknown>[])[0]!["role"]).toBe("user");
      expect((body["messages"] as Record<string, unknown>[])[0]!["content"]).toBe("Hello");
    });

    it("includes optional params in request body", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = makeProvider();
      await p.complete(makeCtx(), makeRequest({
        temperature: 0.7,
        maxTokens: 100,
        seed: 42,
        topP: 0.9,
        stop: ["END"],
      }));

      const call = fetchMock.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body["temperature"]).toBe(0.7);
      expect(body["max_tokens"]).toBe(100);
      expect(body["seed"]).toBe(42);
      expect(body["top_p"]).toBe(0.9);
      expect(body["stop"]).toEqual(["END"]);
    });

    it("serialises tool definitions", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = makeProvider();
      await p.complete(makeCtx(), makeRequest({
        tools: [{
          type: "function",
          function: { name: "get_weather", description: "Get weather", parameters: { city: "string" } },
        }],
        toolChoice: "auto",
      }));

      const call = fetchMock.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
      const tools = body["tools"] as Record<string, unknown>[];
      expect(tools).toHaveLength(1);
      expect(tools[0]!["type"]).toBe("function");
      expect((tools[0]!["function"] as Record<string, unknown>)["name"]).toBe("get_weather");
      expect(body["tool_choice"]).toBe("auto");
    });

    it("serialises response_format", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = makeProvider();
      await p.complete(makeCtx(), makeRequest({ responseFormat: { type: "json_object" } }));

      const call = fetchMock.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body["response_format"]).toEqual({ type: "json_object" });
    });

    it("normalises the OpenAI response", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello, how can I help?" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const p = makeProvider();
      const resp = await p.complete(makeCtx(), makeRequest());

      expect(resp.id).toBe("resp-1");
      expect(resp.model).toBe("gpt-4");
      expect(resp.provider).toBe("test-provider");
      expect(resp.choices).toHaveLength(1);
      expect(resp.choices[0]!.message?.content).toBe("Hello, how can I help?");
      expect(resp.choices[0]!.finishReason).toBe("stop");
      expect(resp.usage.promptTokens).toBe(10);
      expect(resp.usage.completionTokens).toBe(5);
      expect(resp.usage.totalTokens).toBe(15);
    });

    it("normalises finish_reason", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "gpt-4",
        choices: [{ index: 0, message: {}, finish_reason: "model_length" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = makeProvider();
      const resp = await p.complete(makeCtx(), makeRequest());
      expect(resp.choices[0]!.finishReason).toBe("length");
    });

    it("extracts extra response fields into metadata", async () => {
      const p = createOpenAICompatProvider({
        name: "test-provider",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        models: ["test-model"],
        extraResponseFields: ["citations"],
      });

      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        citations: ["https://example.com"],
      });

      const resp = await p.complete(makeCtx(), makeRequest());
      expect(resp.metadata).toBeDefined();
      expect(resp.metadata!["citations"]).toEqual(["https://example.com"]);
    });

    it("handles errors from upstream", async () => {
      mockFetch(429, { error: { message: "Rate limit exceeded" } }, { "Retry-After": "30" });

      const p = makeProvider();
      try {
        await p.complete(makeCtx(), makeRequest());
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        const pe = err as ProviderError;
        expect(pe.statusCode).toBe(429);
        expect(pe.message).toContain("Rate limit exceeded");
        expect(pe.retryAfter).toBe("30");
      }
    });

    it("handles network errors", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Connection refused"));

      const p = makeProvider();
      await expect(p.complete(makeCtx(), makeRequest())).rejects.toThrow(ProviderError);
    });

    it("passes AbortSignal to fetch", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const controller = new AbortController();
      const p = makeProvider();
      await p.complete({ metadata: {}, signal: controller.signal }, makeRequest());

      const call = fetchMock.mock.calls[0]!;
      const init = call[1] as RequestInit;
      expect(init.signal).toBe(controller.signal);
    });

    it("serialises tool_calls in assistant messages", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = makeProvider();
      const resp = await p.complete(makeCtx(), makeRequest());
      const toolCalls = resp.choices[0]!.message?.toolCalls;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls![0]!.id).toBe("call_1");
      expect(toolCalls![0]!.function.name).toBe("get_weather");
      expect(resp.choices[0]!.finishReason).toBe("tool_calls");
    });
  });

  describe("completeStream()", () => {
    it("streams SSE chunks", async () => {
      mockFetchStream([
        'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"test-model","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"test-model","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
      ]);

      const p = makeProvider();
      const chunks: unknown[] = [];
      for await (const chunk of p.completeStream(makeCtx(), makeRequest())) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect((chunks[0] as Record<string, unknown>).choices).toBeDefined();
    });

    it("sets stream: true in the request", async () => {
      mockFetchStream([
        'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"test-model","choices":[]}\n\n',
      ]);

      const p = makeProvider();
      for await (const _chunk of p.completeStream(makeCtx(), makeRequest())) {
        // consume
      }

      const call = fetchMock.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body["stream"]).toBe(true);
    });

    it("rejects on upstream error", async () => {
      mockFetch(500, { error: { message: "Internal error" } });

      const p = makeProvider();
      const iter = p.completeStream(makeCtx(), makeRequest());
      await expect(iter.next()).rejects.toThrow(ProviderError);
    });

    it("applies bodyTransform for streaming requests", async () => {
      mockFetchStream([
        'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"test-model","choices":[]}\n\n',
      ]);

      const p = createOpenAICompatProvider({
        name: "test-provider",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        models: ["test-model"],
        bodyTransform: (body) => ({ ...body, extra_field: true }),
      });

      for await (const _chunk of p.completeStream(makeCtx(), makeRequest())) {
        // consume
      }

      const call = fetchMock.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body["extra_field"]).toBe(true);
    });
  });

  describe("capability enforcement", () => {
    it("rejects unsupported params in reject mode", async () => {
      // Groq does not support seed.
      const p = createOpenAICompatProvider({
        name: "groq",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        models: ["test-model"],
        compatibility: "reject",
      });

      await expect(
        p.complete(makeCtx(), makeRequest({ seed: 42 })),
      ).rejects.toThrow("groq does not support");

      // Verify fetch was never called.
      expect(fetch).not.toHaveBeenCalled();
    });

    it("drops unsupported params in drop mode", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = createOpenAICompatProvider({
        name: "groq",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        models: ["test-model"],
        compatibility: "drop",
      });

      await p.complete(makeCtx(), makeRequest({ seed: 42 }));

      const call = fetchMock.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
      // seed should have been dropped.
      expect(body["seed"]).toBeUndefined();
    });
  });

  describe("special providers", () => {
    it("sets extra headers (e.g., HTTP-Referer for OpenRouter)", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = createOpenAICompatProvider({
        name: "openrouter",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        models: ["test-model"],
        extraHeaders: { "HTTP-Referer": "https://myapp.com" },
      });

      await p.complete(makeCtx(), makeRequest());

      const call = fetchMock.mock.calls[0]!;
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers["HTTP-Referer"]).toBe("https://myapp.com");
    });

    it("strips trailing slashes from baseURL", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = makeProvider({ baseURL: "https://api.example.com/v1/" });
      await p.complete(makeCtx(), makeRequest());

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toBe("https://api.example.com/v1/chat/completions");
    });

    it("works without an API key (e.g., Ollama)", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = makeProvider({ apiKey: "" });
      await p.complete(makeCtx(), makeRequest());

      const call = fetchMock.mock.calls[0]!;
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      // No Authorization header when apiKey is empty.
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("applies bodyTransform for non-streaming requests", async () => {
      mockFetch(200, {
        id: "resp-1",
        object: "chat.completion",
        created: 1234,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const p = createOpenAICompatProvider({
        name: "test-provider",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        models: ["test-model"],
        bodyTransform: (body) => ({ ...body, custom_key: "value" }),
      });

      await p.complete(makeCtx(), makeRequest());

      const call = fetchMock.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body["custom_key"]).toBe("value");
    });
  });
});
