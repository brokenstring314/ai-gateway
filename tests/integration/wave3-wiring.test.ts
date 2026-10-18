import { describe, it, expect, beforeAll, afterEach, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { KeyStore } from "@/persistence/key-store";
import { RequestLogStore } from "@/persistence/request-log-store";
import { ShutdownManager } from "@/server/shutdown";
import type { GatewayConfig } from "@/config/types";
import type { IProvider, ChatCompletionRequest, ChatCompletionResponse, RequestContext } from "@/providers/types";

function makeConfig(): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["mock"] },
    targets: [
      {
        name: "mock",
        provider: "openai",
        apiKey: "sk-target",
        baseURL: "https://upstream.example/v1",
        models: ["gpt-4o"],
      },
    ],
    adminSecret: "test-admin-secret-1234",
    server: { port: 3199, host: "127.0.0.1" },
    passthroughProxy: { enabled: true, routes: ["POST /v1/files"] },
  };
}

function makeMockProvider(): IProvider {
  return {
    name: "mock",
    async complete(_ctx: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      return {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: req.model,
        provider: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finishReason: "stop" }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    supportedModels: () => ["gpt-4o"],
    supportsModel: (model: string) => model === "gpt-4o",
    models: () => [{ id: "gpt-4o", ownedBy: "mock" }],
  };
}

describe("Wave 3 wiring (integration)", () => {
  let gateway: Gateway;
  let keyStore: KeyStore;
  let logStore: RequestLogStore;
  let app: ReturnType<typeof createApp>;
  let apiKey: string;
  let shutdown: ShutdownManager;

  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = makeConfig();
    gateway = new Gateway(config);
    gateway.registerProvider(makeMockProvider());

    keyStore = await KeyStore.create(new Database(":memory:"));
    logStore = await RequestLogStore.create(new Database(":memory:"));
    apiKey = keyStore.create("test-key", ["admin"]).key;

    shutdown = new ShutdownManager({ logger: () => {} });
    app = createApp(gateway, config, undefined, keyStore, {
      logStore,
      adminSecret: config.adminSecret,
      inFlightTracker: shutdown.inFlight,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("/health returns 200 ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("/livez returns 200", async () => {
    const res = await app.request("/livez");
    expect(res.status).toBe(200);
  });

  it("/readyz returns 200 when gateway is ready", async () => {
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestJson;
    expect(body.status).toBe("ok");
  });

  it("/metrics returns Prometheus text with required metrics", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("ai_gateway_requests_total");
    expect(text).toContain("ai_gateway_request_duration_seconds");
    expect(text).toContain("ai_gateway_tokens_input_total");
  });

  it("console shells are public, carry no data, and set the strict CSP", async () => {
    for (const page of ["", "/keys", "/logs", "/config", "/login"]) {
      const res = await app.request(`/admin/dashboard${page}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
      const html = await res.text();
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html).not.toMatch(/\son\w+="/);
      expect(html).not.toContain("sk-target");
    }
  });

  it("removed placeholder pages are gone", async () => {
    for (const page of ["/providers", "/analytics", "/playground", "/getting-started"]) {
      expect((await app.request(`/admin/dashboard${page}`)).status).not.toBe(200);
    }
  });

  it("console data endpoint requires admin auth", async () => {
    expect((await app.request("/admin/status")).status).toBe(401);
    const res = await app.request("/admin/status", { headers: { "X-Admin-Secret": "test-admin-secret-1234" } });
    expect(res.status).toBe(200);
  });

  it("console static assets are served", async () => {
    const css = await app.request("/admin/static/console.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toContain("text/css");
    const js = await app.request("/admin/static/console.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("Content-Type")).toContain("javascript");
  });

  it("admin keys API works end-to-end with SQLite store", async () => {
    const res = await app.request("/admin/keys", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestJson;
    expect(body.total).toBe(1);
    expect(body.keys[0].keyDisplay).toBeDefined();
    expect(body.keys[0].key).toBeUndefined();
  });

  it("proxy route rejects unauthenticated /v1/* requests", async () => {
    const res = await app.request("/v1/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as TestJson;
    expect(body.error.code).toBe("missing_authorization");
  });

  it("proxy route passes authenticated /v1/* requests upstream", async () => {
    const res = await app.request("/v1/files", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider": "mock",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ purpose: "fine-tune" }),
    });
    expect(res.status).toBe(200);
    const fetchCall = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(fetchCall[0]).toBe("https://upstream.example/v1/files");
    const forwarded = new Headers(fetchCall[1].headers as Headers);
    expect(forwarded.get("Authorization")).toBe("Bearer sk-target");
  });

  it("shutdown manager drains and closes registered components", async () => {
    const closed: string[] = [];
    shutdown.register({
      name: "component-a",
      close: () => {
        closed.push("a");
      },
    });
    shutdown.register({
      name: "component-b",
      close: () => {
        closed.push("b");
      },
    });
    await shutdown.shutdown("test");
    expect(closed).toEqual(["a", "b"]);
    expect(shutdown.isShuttingDown).toBe(true);
  });

  it("in-flight tracker drains after requests complete", async () => {
    shutdown.inFlight.increment();
    const draining = shutdown.inFlight.drain(500);
    shutdown.inFlight.decrement();
    await expect(draining).resolves.toBe(true);
  });
});
