import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Database } from "bun:sqlite";
import { Gateway } from "../../src/gateway.js";
import { createApp } from "../../src/app.js";
import { KeyStore } from "../../src/persistence/key-store.js";
import type { GatewayConfig } from "../../src/config/types.js";
import type { IProvider, IStreamProvider, ChatCompletionRequest, ChatCompletionResponse, StreamChunk, RequestContext } from "../../src/providers/types.js";

async function createTestKeyStore(keys: Array<{ name: string; scopes: string[] }>): Promise<{ store: KeyStore; keys: string[] }> {
  const db = new Database(":memory:");
  const store = await KeyStore.create(db);
  const created: string[] = [];
  for (const k of keys) {
    created.push(store.create(k.name, k.scopes).key);
  }
  return { store, keys: created };
}

function createMockProvider(name: string, models: string[]): IProvider & IStreamProvider {
  const modelList = models.map((id) => ({ id, ownedBy: name }));
  return {
    name,
    async complete(_ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        provider: name,
        choices: [{
          index: 0,
          message: { role: "assistant", content: `Hello from ${name}! Model: ${req.model}` },
          finishReason: "stop",
        }],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      };
    },
    async *completeStream(_ctx: RequestContext, req: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
      yield {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "Hello" },
          finishReason: "",
        }],
      };
      yield {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{
          index: 0,
          delta: { content: ` from ${name}!` },
          finishReason: "stop",
        }],
      };
    },
    supportedModels(): string[] { return models; },
    supportsModel(model: string): boolean { return models.includes(model); },
    models() { return modelList; },
  };
}

function createTestConfig(): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["test-provider"] },
    targets: [{
      name: "test-provider",
      provider: "openai",
      apiKey: "test-key",
      baseURL: "http://localhost:9999/v1",
      models: ["gpt-4", "gpt-3.5-turbo"],
    }],
    auth: { enabled: true, keys: ["sk-test-key-123"] },
    adminSecret: "test-admin-secret-1234",
    maxRequestBytes: 1024 * 1024,
    requestTimeout: "30s",
    cors: { enabled: true, origins: ["http://localhost:3000"] },
  };
}

describe("Integration: Full HTTP lifecycle", () => {
  let gateway: Gateway;
  let app: ReturnType<typeof createApp>;
  let apiKey: string;
  let keyStore: KeyStore;

  beforeAll(async () => {
    const config = createTestConfig();
    gateway = new Gateway(config);
    const mockProvider = createMockProvider("test-provider", ["gpt-4", "gpt-3.5-turbo"]);
    gateway.registerProvider(mockProvider);
    const created = await createTestKeyStore([{ name: "test-key", scopes: ["admin"] }]);
    keyStore = created.store;
    apiKey = created.keys[0]!;
    app = createApp(gateway, config, undefined, keyStore);
  });

  afterAll(() => {
    keyStore.close();
  });

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /v1/models returns model list", async () => {
    const res = await app.request("/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBeDefined();
  });

  it("POST /v1/chat/completions (non-streaming) works", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toContain("Hello from test-provider");
    expect(body.usage.totalTokens).toBe(30);
  });

  it("POST /v1/chat/completions (streaming) returns SSE", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("[DONE]");
  });

  it("POST /v1/chat/completions with invalid JSON returns 400", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("POST /v1/chat/completions with missing model returns 400", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("POST /v1/completions (legacy) works", async () => {
    const res = await app.request("/v1/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4",
        prompt: "Hello",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
  });
});

describe("Integration: Auth middleware", () => {
  let app: ReturnType<typeof createApp>;
  let apiKey: string;
  let keyStore: KeyStore;

  beforeAll(async () => {
    const config = createTestConfig();
    const gateway = new Gateway(config);
    const mockProvider = createMockProvider("test-provider", ["gpt-4"]);
    gateway.registerProvider(mockProvider);
    const created = await createTestKeyStore([{ name: "test-key", scopes: ["admin"] }]);
    keyStore = created.store;
    apiKey = created.keys[0]!;
    app = createApp(gateway, config, undefined, keyStore);
  });

  afterAll(() => {
    keyStore.close();
  });

  it("rejects request without Authorization header", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("missing_authorization");
  });

  it("rejects request with invalid API key", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("accepts request with valid API key", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("health endpoint does not require auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

describe("Integration: Security headers", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["test"] },
      targets: [{ name: "test", provider: "openai", apiKey: "key", baseURL: "http://localhost:9999/v1", models: ["gpt-4"] }],
    };
    const gateway = new Gateway(config);
    app = createApp(gateway, config);
  });

  it("adds X-Content-Type-Options header", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("adds X-Frame-Options header", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("adds Referrer-Policy header", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("Integration: Body limit middleware", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["test"] },
      targets: [{ name: "test", provider: "openai", apiKey: "key", baseURL: "http://localhost:9999/v1", models: ["gpt-4"] }],
      maxRequestBytes: 100,
    };
    const gateway = new Gateway(config);
    app = createApp(gateway, config);
  });

  it("rejects oversized request body", async () => {
    const bigBody = JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "A".repeat(200) }],
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(bigBody.length),
      },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });
});

describe("Integration: Admin API", () => {
  let app: ReturnType<typeof createApp>;
  let config: GatewayConfig;

  beforeAll(() => {
    config = {
      strategy: { mode: "single", targets: ["test"] },
      targets: [{ name: "test", provider: "openai", apiKey: "sk-secret-key", baseURL: "http://localhost:9999/v1", models: ["gpt-4"] }],
      auth: { enabled: true, keys: ["sk-admin-key"] },
      adminSecret: "test-admin-secret-1234",
    };
    const gateway = new Gateway(config);
    app = createApp(gateway, config, "/tmp/test-config.yaml");
  });

  it("GET /admin/config returns redacted config", async () => {
    const res = await app.request("/admin/config", {
      headers: { "X-Admin-Secret": "test-admin-secret-1234" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.strategy.mode).toBe("single");
  });

  it("GET /admin/keys returns key list", async () => {
    const res = await app.request("/admin/keys", {
      headers: { "X-Admin-Secret": "test-admin-secret-1234" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBe(true);
  });

  it("POST /admin/keys adds a new key", async () => {
    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Secret": "test-admin-secret-1234" },
      body: JSON.stringify({ key: "sk-new-key" }),
    });
    expect(res.status).toBe(201);
  });

  it("GET /admin/logs returns log entries", async () => {
    const res = await app.request("/admin/logs", {
      headers: { "X-Admin-Secret": "test-admin-secret-1234" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("Admin API rejects requests without secret", async () => {
    const res = await app.request("/admin/config");
    expect(res.status).toBe(401);
  });

  it("Admin API rejects requests with wrong secret", async () => {
    const res = await app.request("/admin/config", {
      headers: { "X-Admin-Secret": "wrong-secret" },
    });
    expect(res.status).toBe(401);
  });
});

describe("Integration: Metrics endpoint", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["test"] },
      targets: [{ name: "test", provider: "openai", apiKey: "key", baseURL: "http://localhost:9999/v1", models: ["gpt-4"] }],
    };
    const gateway = new Gateway(config);
    const mockProvider = createMockProvider("test", ["gpt-4"]);
    gateway.registerProvider(mockProvider);
    app = createApp(gateway, config);
  });

  it("GET /metrics returns Prometheus text format", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("ai_gateway_requests_total");
  });
});

describe("Integration: Gateway with observability", () => {
  it("records metrics after route()", async () => {
    const { getMetrics } = await import("../../src/observability/metrics.js");
    const metrics = getMetrics();
    metrics.reset();

    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["obs-test"] },
      targets: [{ name: "obs-test", provider: "openai", apiKey: "key", baseURL: "http://localhost:9999/v1", models: ["gpt-4"] }],
    };
    const gateway = new Gateway(config);
    const mockProvider = createMockProvider("obs-test", ["gpt-4"]);
    gateway.registerProvider(mockProvider);

    await gateway.route(
      { metadata: {} },
      { model: "gpt-4", messages: [{ role: "user", content: "test" }] },
    );

    const formatted = metrics.format();
    expect(formatted).toContain("ai_gateway_requests_total");
    expect(formatted).toContain('provider="obs-test"');
    metrics.reset();
  });
});

describe("Integration: Model aliases", () => {
  it("resolves model alias before routing", async () => {
    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["alias-test"] },
      targets: [{ name: "alias-test", provider: "openai", apiKey: "key", baseURL: "http://localhost:9999/v1", models: ["gpt-4"] }],
      aliases: { "my-gpt4": "gpt-4" },
    };
    const gateway = new Gateway(config);
    const mockProvider = createMockProvider("alias-test", ["gpt-4"]);
    gateway.registerProvider(mockProvider);

    const response = await gateway.route(
      { metadata: {} },
      { model: "my-gpt4", messages: [{ role: "user", content: "test" }] },
    );
    expect(response.model).toBe("gpt-4");
  });
});

describe("Integration: Config reload", () => {
  it("reloadConfig rebuilds strategy and providers", () => {
    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["old"] },
      targets: [{ name: "old", provider: "openai", apiKey: "key", baseURL: "http://localhost:9999/v1", models: ["gpt-3.5-turbo"] }],
    };
    const gateway = new Gateway(config);

    const newConfig: GatewayConfig = {
      strategy: { mode: "fallback", targets: ["new1", "new2"] },
      targets: [
        { name: "new1", provider: "deepseek", apiKey: "key2", baseURL: "http://localhost:9998/v1", models: ["deepseek-chat"] },
        { name: "new2", provider: "groq", apiKey: "key3", baseURL: "http://localhost:9997/v1", models: ["llama3"] },
      ],
    };
    gateway.reloadConfig(newConfig);
    expect(gateway.getConfig().strategy.mode).toBe("fallback");
    expect(gateway.listModels().map((m) => m.id)).toEqual(expect.arrayContaining(["deepseek-chat", "llama3"]));
  });
});

describe("Integration: Plugin chain in gateway", () => {
  it("before_request plugin can modify request", async () => {
    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["plug-test"] },
      targets: [{ name: "plug-test", provider: "openai", apiKey: "key", baseURL: "http://localhost:9999/v1", models: ["gpt-4"] }],
    };
    const gateway = new Gateway(config);
    const mockProvider = createMockProvider("plug-test", ["gpt-4"]);
    gateway.registerProvider(mockProvider);

    gateway.registerPlugin("before_request", {
      name: "model-override",
      stage: "before_request",
      async execute(ctx) {
        ctx.request = { ...ctx.request, model: "gpt-4" };
        return { action: "modify" as const, request: ctx.request };
      },
    });

    const response = await gateway.route(
      { metadata: {} },
      { model: "gpt-4", messages: [{ role: "user", content: "test" }] },
    );
    expect(response.model).toBe("gpt-4");
  });
});
