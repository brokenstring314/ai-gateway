// Regression tests: config.plugins wiring (H3), short-circuit honoured by the
// gateway + safe cache keys (H4), per-API-key plugin buckets (H5).
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { CachePlugin, RateLimitPlugin, buildPluginsFromConfig } from "@/plugins";
import { createPluginContext, apiKeyId } from "@/plugins/context";
import { PluginManager } from "@/plugins/manager";
import { KeyStore } from "@/persistence/key-store";
import type { GatewayConfig } from "@/config/types";
import type {
  ChatCompletionRequest, ChatCompletionResponse, IProvider, IStreamProvider, RequestContext, StreamChunk,
} from "@/providers/types";

function cfg(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["mock"] },
    targets: [{ name: "mock", provider: "openai", apiKey: "sk", baseURL: "https://up.example/v1", models: ["gpt-4o"] }],
    ...extra,
  } as GatewayConfig;
}

function mockProvider(calls: ChatCompletionRequest[]): IProvider & IStreamProvider {
  return {
    name: "mock",
    async complete(_c: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      calls.push(req);
      return {
        id: "x", object: "chat.completion", created: 1, model: req.model, provider: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: `answer#${calls.length}` }, finishReason: "stop" }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async *completeStream(_c: RequestContext, req: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
      calls.push(req);
      yield { id: "x", object: "chat.completion.chunk", created: 1, model: req.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finishReason: null }] } as unknown as StreamChunk;
    },
    supportedModels: () => ["gpt-4o"],
    supportsModel: (m: string) => m === "gpt-4o",
    models: () => [{ id: "gpt-4o", ownedBy: "mock" }],
  } as unknown as IProvider & IStreamProvider;
}

const uniq = () => `${Date.now()}-${Math.random()}`;
const msg = (t: string): ChatCompletionRequest => ({ model: "gpt-4o", messages: [{ role: "user", content: t }] });
const content = (r: ChatCompletionResponse) => r.choices[0]?.message?.content;

function gatewayWithCache(calls: ChatCompletionRequest[]): Gateway {
  const gw = new Gateway(cfg());
  gw.registerProvider(mockProvider(calls));
  gw.registerPlugin("before_request", new CachePlugin({ ttlSeconds: 60 }, "before_request"));
  gw.registerPlugin("after_request", new CachePlugin({ ttlSeconds: 60 }, "after_request"));
  return gw;
}

function cacheKey(req: Partial<ChatCompletionRequest>, apiKey?: string): unknown {
  const plugin = new CachePlugin({ ttlSeconds: 60 }, "before_request");
  const ctx = createPluginContext({ ...msg("same-" + "key"), ...req } as ChatCompletionRequest, { metadata: { apiKey } });
  void plugin.execute(ctx);
  return ctx.metadata["_cacheKey"];
}

describe("H4: short_circuit result is honoured", () => {
  it("PluginManager sets the short-circuit flag for {action:'short_circuit'}", async () => {
    const pm = new PluginManager();
    const resp = { id: "c" } as ChatCompletionResponse;
    pm.register("before_request", { name: "sc", stage: "before_request", execute: async () => ({ action: "short_circuit", response: resp }) });
    const ctx = createPluginContext(msg("a"));
    await pm.runBefore(ctx);
    expect(ctx._shortCircuited).toBe(true);
    expect(ctx.response).toBe(resp);
  });

  it("Gateway.route serves the second identical request from cache", async () => {
    const calls: ChatCompletionRequest[] = [];
    const gw = gatewayWithCache(calls);
    const req = msg("cache-me-" + uniq());
    const a = await gw.route({ metadata: {} }, req);
    const b = await gw.route({ metadata: {} }, req);
    expect(calls.length).toBe(1);
    expect(content(b)).toBe(content(a));
  });

  it("streaming requests are never short-circuited by the cache (no 403)", async () => {
    const calls: ChatCompletionRequest[] = [];
    const gw = gatewayWithCache(calls);
    const text = "stream-" + uniq();
    await gw.route({ metadata: {} }, msg(text)); // populate cache for the non-stream variant
    const chunks: StreamChunk[] = [];
    for await (const ch of gw.routeStream({ metadata: {} }, { ...msg(text), stream: true })) chunks.push(ch);
    expect(chunks.length).toBe(1);
    expect(calls.length).toBe(2);
  });

  it("cache key covers every response-affecting param", () => {
    expect(cacheKey({ n: 1 })).not.toBe(cacheKey({ n: 3 }));
    expect(cacheKey({ topP: 0.1 })).not.toBe(cacheKey({ topP: 0.9 }));
    expect(cacheKey({ stop: ["a"] })).not.toBe(cacheKey({ stop: ["b"] }));
    expect(cacheKey({ responseFormat: { type: "text" } } as never)).not.toBe(cacheKey({ responseFormat: { type: "json_object" } } as never));
    expect(cacheKey({ toolChoice: "auto" } as never)).not.toBe(cacheKey({ toolChoice: "none" } as never));
    expect(cacheKey({ user: "alice" })).not.toBe(cacheKey({ user: "bob" }));
    expect(cacheKey({ temperature: 0, topP: 1 })).toBe(cacheKey({ topP: 1, temperature: 0 }));
  });

  it("cache is isolated per API key (no cross-tenant hits)", async () => {
    expect(cacheKey({}, "tenant-a")).not.toBe(cacheKey({}, "tenant-b"));
    const calls: ChatCompletionRequest[] = [];
    const gw = gatewayWithCache(calls);
    const req = msg("tenant-" + uniq());
    await gw.route({ metadata: { apiKey: "tenant-a" } }, req);
    const b = await gw.route({ metadata: { apiKey: "tenant-b" } }, req);
    expect(calls.length).toBe(2);
    expect(content(b)).toBe("answer#2");
  });
});

describe("H5: plugins bucket by authenticated API key", () => {
  let db: Database | undefined;
  afterEach(() => db?.close());

  it("plugin metadata carries a hashed key id, never the raw key", () => {
    const ctx = createPluginContext(msg("a"), { metadata: { apiKey: "sk-secret-123" } });
    expect(ctx.metadata["api_key"]).toBe(apiKeyId("sk-secret-123"));
    expect(JSON.stringify(ctx.metadata)).not.toContain("sk-secret-123");
  });

  it("rate limit applies per API key over HTTP", async () => {
    db = new Database(":memory:");
    const keyStore = await KeyStore.create(db);
    const keyA = keyStore.create("a", ["admin"]).key;
    const keyB = keyStore.create("b", ["admin"]).key;
    const gw = new Gateway(cfg());
    gw.registerProvider(mockProvider([]));
    gw.registerPlugin("before_request", new RateLimitPlugin({ maxRequestsPerMinute: 1 }));
    const app = createApp(gw, cfg(), undefined, keyStore);
    const post = (k: string) => app.request("/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" }, body: JSON.stringify(msg("a")),
    });
    expect((await post(keyA)).status).toBe(200);
    expect((await post(keyB)).status).toBe(200);
    expect((await post(keyA)).status).not.toBe(200);
  });
});

describe("H3: config.plugins are instantiated", () => {
  it("word-filter from config rejects blocked content", async () => {
    const c = cfg({ plugins: [{ name: "word-filter", stage: "before_request", config: { blocklist: ["badword"], mode: "reject" } }] });
    const gw = new Gateway(c);
    gw.registerProvider(mockProvider([]));
    const app = createApp(gw, c);
    const r = await app.request("/v1/chat/completions", { method: "POST", body: JSON.stringify(msg("a badword here")) });
    expect(r.status).not.toBe(200);
  });

  it("cache from config (snake_case name, documented keys) registers both stages and hits", async () => {
    const regs = buildPluginsFromConfig([{ name: "cache", stage: "before_request", config: { maxAge: 60, maxEntries: 10 } }]);
    expect(regs.map((r) => r.stage).sort()).toEqual(["after_request", "before_request"]);

    const calls: ChatCompletionRequest[] = [];
    const gw = new Gateway(cfg({ plugins: [{ name: "cache", stage: "before_request", config: { ttlSeconds: 60 } }] }));
    gw.registerProvider(mockProvider(calls));
    const req = msg("cfg-cache-" + uniq());
    await gw.route({ metadata: {} }, req);
    await gw.route({ metadata: {} }, req);
    expect(calls.length).toBe(1);
  });

  it("maps every builtin name (kebab or snake case) to its stages", () => {
    const regs = buildPluginsFromConfig([
      { name: "rate_limit", stage: "before_request", config: { keyRpm: 60 } },
      { name: "logger", stage: "after_request" },
      { name: "word_filter", stage: "before_request", config: { blockedWords: ["x"] } },
      { name: "max_token", stage: "before_request", config: { maxTokens: 100 } },
      { name: "budget", stage: "before_request", config: { dailyBudget: 1 } },
      { name: "cache", stage: "before_request", enabled: false },
    ]);
    expect(regs.map((r) => `${r.plugin.name}@${r.stage}`)).toEqual([
      "rate-limit@before_request",
      "logger@after_request",
      "word-filter@before_request",
      "max-token@before_request",
      "budget@before_request",
      "budget@after_request",
    ]);
  });

  it("rejects invalid builtin config instead of silently ignoring it", () => {
    expect(() => buildPluginsFromConfig([{ name: "budget", stage: "before_request", config: {} }])).toThrow(/dailyBudget/);
  });

  it("reloadConfig swaps config plugins and keeps programmatic ones", async () => {
    const calls: ChatCompletionRequest[] = [];
    const c = cfg({ plugins: [{ name: "word-filter", stage: "before_request", config: { blocklist: ["old"] } }] });
    const gw = new Gateway(c);
    gw.registerProvider(mockProvider(calls));
    gw.registerPlugin("before_request", new RateLimitPlugin({ maxRequestsPerMinute: 1000, key: "reload-" + uniq() }));
    await expect(gw.route({ metadata: {} }, msg("old"))).rejects.toThrow();
    gw.reloadConfig(cfg({ plugins: [{ name: "word-filter", stage: "before_request", config: { blocklist: ["new"] } }] }));
    gw.registerProvider(mockProvider(calls));
    await gw.route({ metadata: {} }, msg("old"));
    await expect(gw.route({ metadata: {} }, msg("new"))).rejects.toThrow();
  });
});

describe("createPluginContext", () => {
  it("tolerates a RequestContext without metadata", () => {
    const ctx = createPluginContext(msg("a"), {} as RequestContext);
    expect(ctx.metadata["api_key"]).toBeUndefined();
  });
});
