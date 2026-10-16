import { describe, it, expect, vi, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/app";
import type { Gateway } from "@/gateway";
import type { ChatCompletionResponse } from "@/providers/types";
import { ProviderError } from "@/providers/openai-compat";
import { PluginRejectionError } from "@/plugins/error";

function makeResponse(overrides?: Partial<ChatCompletionResponse>): ChatCompletionResponse {
  return {
    id: "resp-1",
    object: "chat.completion",
    created: Date.now(),
    model: "gpt-4",
    provider: "test",
    choices: [
      { index: 0, message: { role: "assistant", content: "hi" }, finishReason: "stop" },
    ],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    ...overrides,
  };
}

function createMockGateway(overrides?: Partial<Gateway>): Gateway {
  return overrides as unknown as Gateway;
}

describe("Chat handler", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = new Hono<AppEnv>();
  });

  it("non-streaming request returns 200 with correct response", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse()),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("resp-1");
  });

  it("streaming request returns 200 with SSE content type", async () => {
    const mockGateway = createMockGateway({
      routeStream: vi.fn().mockImplementation(async function* () {
        yield {
          id: "chunk-1",
          object: "chat.completion.chunk",
          created: Date.now(),
          model: "gpt-4",
          choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finishReason: "stop" }],
        };
      }),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("invalid JSON body returns 400", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn(),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("validation error returns 400", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn(),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation_failed");
  });

  it("X-Gateway-Provider and X-Gateway-Overhead-Ms headers present", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse()),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.headers.get("X-Gateway-Provider")).toBe("test");
    expect(res.headers.get("X-Gateway-Overhead-Ms")).toBeDefined();
  });

  it("plugin rejection returns 403", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockRejectedValue(new PluginRejectionError("before_request", "blocked")),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.type).toBe("plugin_rejection");
  });

  it("provider error returns appropriate status", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockRejectedValue(new ProviderError("openai", 502, "bad gateway")),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(502);
  });
});
