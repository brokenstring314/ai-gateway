/**
 * Unit tests for upstream response-header forwarding on non-proxy handler
 * paths (chat + legacy completions).
 *
 * Providers publish whitelisted upstream headers (x-ratelimit-*, x-request-id,
 * retry-after) either on the response (`upstreamHeaders`) for non-streaming or
 * on the RequestContext for streaming; the handlers must copy exactly those
 * onto the client response, never hop-by-hop headers and never anything
 * outside the fixed whitelist.
 */
import { describe, it, expect, vi, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/app";
import type { Gateway } from "@/gateway";
import type {
  ChatCompletionResponse,
  RequestContext,
  StreamChunk,
} from "@/providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeChunk(overrides?: Partial<StreamChunk>): StreamChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-4",
    choices: [
      { index: 0, delta: { role: "assistant", content: "hi" }, finishReason: "stop" },
    ],
    ...overrides,
  };
}

const CHAT_BODY = {
  model: "gpt-4",
  messages: [{ role: "user" as const, content: "hello" }],
};

async function postChat(app: Hono<AppEnv>, body: Record<string, unknown>): Promise<Response> {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postCompletions(app: Hono<AppEnv>, body: Record<string, unknown>): Promise<Response> {
  return app.request("/v1/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Upstream response-header forwarding", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = new Hono<AppEnv>();
  });

  it("forwards x-ratelimit-remaining from the provider response", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse({
        upstreamHeaders: { "x-ratelimit-remaining": "42" },
      })),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, CHAT_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("42");
  });

  it("forwards x-request-id from the provider response", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse({
        upstreamHeaders: { "x-request-id": "req_abc123" },
      })),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, CHAT_BODY);
    expect(res.headers.get("x-request-id")).toBe("req_abc123");
  });

  it("forwards retry-after from the provider response", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse({
        upstreamHeaders: { "retry-after": "30" },
      })),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, CHAT_BODY);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("never forwards hop-by-hop headers", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse({
        upstreamHeaders: {
          "connection": "keep-alive",
          "transfer-encoding": "chunked",
          "keep-alive": "timeout=5",
          "x-ratelimit-remaining": "7",
        },
      })),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, CHAT_BODY);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("7");
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(res.headers.get("keep-alive")).toBeNull();
  });

  it("does not forward headers outside the fixed whitelist", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse({
        upstreamHeaders: {
          "x-custom-header": "leak-me",
          "server": "nginx",
          "x-ratelimit-used": "3",
          "x-ratelimit-remaining": "11",
        },
      })),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, CHAT_BODY);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("11");
    expect(res.headers.get("x-custom-header")).toBeNull();
    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("x-ratelimit-used")).toBeNull();
  });

  it("adds no upstream headers when the provider returns none", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse()),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, CHAT_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-remaining")).toBeNull();
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
    expect(res.headers.get("x-request-id")).toBeNull();
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.headers.get("X-Gateway-Provider")).toBe("test");
  });

  it("forwards upstream headers on the streaming path via RequestContext", async () => {
    const mockGateway = createMockGateway({
      routeStream: vi.fn().mockImplementation(async function* (ctx: RequestContext) {
        ctx.upstreamHeaders = { "x-ratelimit-remaining": "99" };
        yield makeChunk();
      }),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, { ...CHAT_BODY, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("99");
  });

  it("adds no upstream headers on the streaming path when none are set", async () => {
    const mockGateway = createMockGateway({
      routeStream: vi.fn().mockImplementation(async function* () {
        yield makeChunk();
      }),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, { ...CHAT_BODY, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-remaining")).toBeNull();
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("forwards upstream headers from the legacy completions handler", async () => {
    // The completions handler runs execute(completionsSurface) (plan 2.9).
    const mockGateway = createMockGateway({
      execute: vi.fn().mockResolvedValue({
        kind: "ok",
        target: "test",
        value: makeResponse({ upstreamHeaders: { "retry-after": "5", "x-request-id": "req_xyz" } }),
      }),
    } as unknown as Gateway);

    const { registerCompletionsHandler } = await import("@/handlers/completions");
    registerCompletionsHandler(app, mockGateway);

    const res = await postCompletions(app, { model: "gpt-4", prompt: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("x-request-id")).toBe("req_xyz");
  });

  it("does not leak upstream headers into the JSON response body", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse({
        upstreamHeaders: { "x-ratelimit-remaining": "42" },
      })),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, CHAT_BODY);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toBe("resp-1");
    expect(body["upstreamHeaders"]).toBeUndefined();
  });

  it("keeps existing response body and gateway headers intact when forwarding", async () => {
    const mockGateway = createMockGateway({
      route: vi.fn().mockResolvedValue(makeResponse({
        upstreamHeaders: { "x-request-id": "req_1" },
      })),
    } as unknown as Gateway);

    const { registerChatHandler } = await import("@/handlers/chat");
    registerChatHandler(app, mockGateway);

    const res = await postChat(app, CHAT_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      choices: readonly { message?: { content?: string } }[];
    };
    expect(body.id).toBe("resp-1");
    expect(body.choices[0]?.message?.content).toBe("hi");
    expect(res.headers.get("X-Gateway-Provider")).toBe("test");
    expect(res.headers.get("X-Gateway-Overhead-Ms")).toBeDefined();
    expect(res.headers.get("x-request-id")).toBe("req_1");
  });
});
