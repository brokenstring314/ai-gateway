/**
 * Unit tests for the OpenAI-compatible pass-through proxy handler and its
 * pure resolution/URL helpers.
 */

import { describe, it, expect, vi } from "bun:test";
import { Hono } from "hono";
import {
  createProxyHandler,
  resolveProxyTarget,
  stripTrailingV1,
  buildUpstreamUrl,
  extractTopLevelModel,
  resolveProvider,
  buildForwardHeaders,
  type ProxyTarget,
  type TargetResolver,
} from "@/proxy/proxy";

function makeTarget(overrides?: Partial<ProxyTarget>): ProxyTarget {
  return {
    name: "openai-main",
    provider: "openai",
    baseURL: "https://api.openai.com",
    apiKey: "sk-target-key",
    authHeaders: { Authorization: "Bearer sk-target-key" },
    ...overrides,
  };
}

/** Simple resolver: provider "openai" and model "gpt-4o" both map to the target. */
function simpleResolver(target: ProxyTarget = makeTarget()): TargetResolver {
  return (selector) => {
    const { provider, model } = selector as { provider?: string; model?: string };
    if (provider === "openai") return target;
    if (model === "gpt-4o") return target;
    return undefined;
  };
}

function mountProxy(
  opts: Parameters<typeof createProxyHandler>[0],
): { app: Hono; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
  );
  const app = new Hono();
  app.all("/v1/*", createProxyHandler({ fetchImpl: fetchImpl as unknown as typeof fetch, ...opts }));
  return { app, fetchImpl };
}

async function lastFetchCall(fetchImpl: ReturnType<typeof vi.fn>): Promise<{
  url: string;
  init: RequestInit;
}> {
  const call = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

describe("stripTrailingV1", () => {
  it("strips a trailing /v1 or /v1/ from the base URL path", () => {
    expect(stripTrailingV1("https://api.x.ai/v1")).toBe("https://api.x.ai");
    expect(stripTrailingV1("https://api.x.ai/v1/")).toBe("https://api.x.ai");
    expect(stripTrailingV1("https://api.openai.com/v1")).toBe("https://api.openai.com");
    expect(stripTrailingV1("https://api.moonshot.cn/v1")).toBe("https://api.moonshot.cn");
  });

  it("leaves base URLs without a trailing /v1 untouched", () => {
    expect(stripTrailingV1("https://api.perplexity.ai")).toBe("https://api.perplexity.ai");
    expect(stripTrailingV1("https://api.deepinfra.com/v1/openai")).toBe("https://api.deepinfra.com/v1/openai");
    expect(stripTrailingV1("https://api.x.ai")).toBe("https://api.x.ai");
  });

  it("returns invalid input unchanged", () => {
    expect(stripTrailingV1("not a url")).toBe("not a url");
    expect(stripTrailingV1("")).toBe("");
  });
});

describe("buildUpstreamUrl", () => {
  it("joins the inbound /v1 path without doubling the segment", () => {
    expect(buildUpstreamUrl("https://api.x.ai/v1", "/v1/responses")).toBe("https://api.x.ai/v1/responses");
    expect(buildUpstreamUrl("https://api.openai.com/v1", "/v1/chat/completions")).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("preserves the inbound /v1 prefix for bare-host base URLs", () => {
    expect(buildUpstreamUrl("https://api.perplexity.ai", "/v1/chat/completions")).toBe("https://api.perplexity.ai/v1/chat/completions");
  });

  it("joins non-/v1 base paths without double slashes", () => {
    expect(buildUpstreamUrl("https://host/api/v1", "/v1/audio/speech")).toBe("https://host/api/v1/audio/speech");
    expect(buildUpstreamUrl("https://host/api/", "/v1/models")).toBe("https://host/api/v1/models");
  });

  it("preserves the search string", () => {
    expect(buildUpstreamUrl("https://host/v1", "/v1/files", "?limit=10")).toBe("https://host/v1/files?limit=10");
  });
});

describe("extractTopLevelModel", () => {
  it("extracts a top-level model string", () => {
    expect(extractTopLevelModel(`{"model":"gpt-4o","messages":[]}`)).toBe("gpt-4o");
    expect(
      extractTopLevelModel(
        `{"messages":[{"role":"user","content":"hello"}],"metadata":{"nested":{"a":[1,2,3],"b":{"c":"d"}}},"model":"gpt-4o","stream":true}`,
      ),
    ).toBe("gpt-4o");
  });

  it("ignores nested model fields", () => {
    expect(extractTopLevelModel(`{"input":{"model":"nested"},"messages":[]}`)).toBeUndefined();
    expect(extractTopLevelModel(`{"metadata":{"model":"nested"},"model":"gpt-4o"}`)).toBe("gpt-4o");
  });

  it("returns undefined for non-string, missing, or malformed input", () => {
    expect(extractTopLevelModel(`{"model":null}`)).toBeUndefined();
    expect(extractTopLevelModel(`{"model":123}`)).toBeUndefined();
    expect(extractTopLevelModel(`{"messages":[]}`)).toBeUndefined();
    expect(extractTopLevelModel(`not json`)).toBeUndefined();
    expect(extractTopLevelModel(`[]`)).toBeUndefined();
    expect(extractTopLevelModel("")).toBeUndefined();
  });

  it("handles escaped characters in the model value", () => {
    expect(extractTopLevelModel(`{"model":"a\\"b"}`)).toBe('a"b');
    expect(extractTopLevelModel(`{"model":"a\\\\b"}`)).toBe("a\\b");
  });
});

describe("resolveProvider", () => {
  it("resolves via the X-Provider header", () => {
    const result = resolveProvider("openai", undefined, simpleResolver());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("openai");
      expect(result.target.baseURL).toBe("https://api.openai.com");
    }
  });

  it("resolves via the top-level model in the body", () => {
    const result = resolveProvider(undefined, `{"model":"gpt-4o","messages":[]}`, simpleResolver());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("openai");
  });

  it("prefers the header over the body model", () => {
    const resolver: TargetResolver = (selector) => {
      const { provider, model } = selector as { provider?: string; model?: string };
      if (provider === "openai") return makeTarget();
      if (model === "gpt-4o") return makeTarget({ provider: "other", name: "other" });
      return undefined;
    };
    const result = resolveProvider("openai", `{"model":"gpt-4o"}`, resolver);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("openai");
  });

  it("does not fall back to the body when the header names an unknown provider", () => {
    const result = resolveProvider("bogus", `{"model":"gpt-4o"}`, simpleResolver());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown_provider");
      expect(result.provider).toBe("bogus");
    }
  });

  it("reports unknown model and no-provider cases", () => {
    const unknownModel = resolveProvider(undefined, `{"model":"gpt-nope"}`, simpleResolver());
    expect(unknownModel.ok).toBe(false);
    if (!unknownModel.ok) expect(unknownModel.reason).toBe("unknown_model");

    const none = resolveProvider(undefined, undefined, simpleResolver());
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("no_provider");
  });
});

describe("resolveProxyTarget", () => {
  it("strips /v1 and builds the default auth headers", () => {
    const target = resolveProxyTarget({
      name: "x",
      provider: "openai",
      apiKey: "sk-1",
      baseURL: "https://api.x.ai/v1",
    });
    expect(target.baseURL).toBe("https://api.x.ai");
    expect(target.authHeaders).toEqual({ Authorization: "Bearer sk-1" });
  });

  it("produces no auth headers when apiKey is empty", () => {
    const target = resolveProxyTarget({
      name: "y",
      provider: "ollama",
      apiKey: "",
      baseURL: "http://localhost:11434/v1",
    });
    expect(target.authHeaders).toEqual({});
  });

  it("honors a custom auth convention", () => {
    const target = resolveProxyTarget(
      { name: "z", provider: "custom", apiKey: "tk-1", baseURL: "https://h/v1" },
      { authHeaders: (t) => ({ "x-api-key": t.apiKey }) },
    );
    expect(target.authHeaders).toEqual({ "x-api-key": "tk-1" });
  });
});

describe("buildForwardHeaders", () => {
  it("forwards ordinary headers and injects target auth", () => {
    const incoming = new Headers({
      Authorization: "Bearer sk-gateway-key",
      "X-Provider": "openai",
      "Content-Type": "application/json",
      Accept: "*/*",
      "X-Custom": "keep-me",
    });
    const out = buildForwardHeaders(incoming, makeTarget());
    expect(out.get("Authorization")).toBe("Bearer sk-target-key");
    expect(out.get("X-Provider")).toBeNull();
    expect(out.get("Content-Type")).toBe("application/json");
    expect(out.get("X-Custom")).toBe("keep-me");
  });

  it("strips gateway credentials and hop-by-hop headers", () => {
    const incoming = new Headers({
      "X-Admin-Secret": "super-secret",
      "X-Gateway-Provider": "spoofed",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      Host: "gateway.local",
    });
    const out = buildForwardHeaders(incoming, makeTarget());
    expect(out.get("X-Admin-Secret")).toBeNull();
    expect(out.get("X-Gateway-Provider")).toBeNull();
    expect(out.get("Connection")).toBeNull();
    expect(out.get("Transfer-Encoding")).toBeNull();
    expect(out.get("Host")).toBeNull();
  });
});

describe("createProxyHandler", () => {
  it("forwards a POST request to the resolved upstream URL with injected auth", async () => {
    const { app, fetchImpl } = mountProxy({
      resolveTarget: simpleResolver(),
      environment: "development",
      allowUnauthenticatedProxy: true,
    });

    const res = await app.request("/v1/files", {
      method: "POST",
      headers: {
        "X-Provider": "openai",
        "Content-Type": "application/json",
        Authorization: "Bearer sk-gateway-key",
      },
      body: JSON.stringify({ purpose: "fine-tune" }),
    });

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const { url, init } = await lastFetchCall(fetchImpl);
    expect(url).toBe("https://api.openai.com/v1/files");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer sk-target-key");
    expect(headers.get("X-Provider")).toBeNull();
    expect(headers.get("Content-Type")).toBe("application/json");

    const forwarded = new TextDecoder().decode(init.body as ArrayBuffer);
    expect(forwarded).toBe(JSON.stringify({ purpose: "fine-tune" }));
    expect(res.headers.get("X-Gateway-Provider")).toBe("openai");
  });

  it("resolves the provider from the body model when no header is set", async () => {
    const { app, fetchImpl } = mountProxy({
      resolveTarget: simpleResolver(),
      allowUnauthenticatedProxy: true,
    });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });

    expect(res.status).toBe(200);
    const { url } = await lastFetchCall(fetchImpl);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("joins a /v1-suffixed target base URL without doubling the prefix", async () => {
    const { app, fetchImpl } = mountProxy({
      resolveTarget: simpleResolver(makeTarget({ baseURL: "https://api.x.ai/v1" })),
      allowUnauthenticatedProxy: true,
    });

    await app.request("/v1/responses", {
      method: "POST",
      headers: { "X-Provider": "openai", "Content-Type": "application/json" },
      body: "{}",
    });

    const { url } = await lastFetchCall(fetchImpl);
    expect(url).toBe("https://api.x.ai/v1/responses");
  });

  it("forwards GET, PUT, and DELETE methods", async () => {
    const { app, fetchImpl } = mountProxy({
      resolveTarget: simpleResolver(),
      allowUnauthenticatedProxy: true,
    });

    for (const method of ["GET", "PUT", "DELETE"]) {
      fetchImpl.mockClear();
      await app.request("/v1/files", { method, headers: { "X-Provider": "openai" } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const { init } = await lastFetchCall(fetchImpl);
      expect(init.method).toBe(method);
    }
  });

  it("passes through streaming responses chunk by chunk", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chunk-1"}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      }),
    );
    const app = new Hono();
    app.all("/v1/*", createProxyHandler({
      resolveTarget: simpleResolver(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowUnauthenticatedProxy: true,
    }));

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "X-Provider": "openai", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Gateway-Provider")).toBe("openai");

    const chunks: string[] = [];
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.join("")).toContain('data: {"id":"chunk-1"}');
    expect(chunks.join("")).toContain("data: [DONE]");
  });

  it("passes through upstream non-200 status and body verbatim", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const app = new Hono();
    app.all("/v1/*", createProxyHandler({
      resolveTarget: simpleResolver(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowUnauthenticatedProxy: true,
    }));

    const res = await app.request("/v1/files", {
      method: "POST",
      headers: { "X-Provider": "openai", "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("rate limited");
  });

  it("returns a stable 502 OpenAI error on upstream transport failure without leaking internals", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(
      new Error("ECONNREFUSED http://10.0.0.5:secret-port/internal"),
    );
    const app = new Hono();
    app.all("/v1/*", createProxyHandler({
      resolveTarget: simpleResolver(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      allowUnauthenticatedProxy: true,
    }));

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "X-Provider": "openai", "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(502);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as {
      error: { message: string; type: string; code: string };
    };
    expect(body.error.type).toBe("server_error");
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toBe("upstream connection failed");
    expect(body.error.message).not.toContain("ECONNREFUSED");
    expect(body.error.message).not.toContain("10.0.0.5");
  });

  it("returns 400 provider_not_resolved when neither header nor model is present", async () => {
    const { app, fetchImpl } = mountProxy({
      resolveTarget: simpleResolver(),
      allowUnauthenticatedProxy: true,
    });

    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("provider_not_resolved");
  });

  it("returns 400 unknown_provider for an unresolvable X-Provider header", async () => {
    const { app, fetchImpl } = mountProxy({
      resolveTarget: simpleResolver(),
      allowUnauthenticatedProxy: true,
    });

    const res = await app.request("/v1/files", {
      method: "GET",
      headers: { "X-Provider": "nonexistent" },
    });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unknown_provider");
    expect(body.error.message).toContain("nonexistent");
  });

  it("returns 400 model_not_found for a model no target serves", async () => {
    const { app, fetchImpl } = mountProxy({
      resolveTarget: simpleResolver(),
      allowUnauthenticatedProxy: true,
    });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-nope", messages: [] }),
    });

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });

  it("returns 502 when the target base URL is empty", async () => {
    const { app, fetchImpl } = mountProxy({
      resolveTarget: simpleResolver(makeTarget({ baseURL: "" })),
      allowUnauthenticatedProxy: true,
    });

    const res = await app.request("/v1/files", {
      method: "GET",
      headers: { "X-Provider": "openai" },
    });

    expect(res.status).toBe(502);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
