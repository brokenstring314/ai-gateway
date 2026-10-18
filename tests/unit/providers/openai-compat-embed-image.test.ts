/**
 * Regression tests (H6): the OpenAI-compatible adapter implements embed()
 * and generateImage(), and /v1/embeddings + /v1/images/generations work
 * end-to-end in OpenAI wire format.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createOpenAICompatProvider, ProviderError } from "@/providers/openai-compat";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import type { GatewayConfig } from "@/config/types";

const originalFetch = globalThis.fetch;
type Captured = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const provider = () =>
  createOpenAICompatProvider({ name: "p", baseURL: "https://up.example/v1/", apiKey: "sk-x", models: ["emb", "img"] });

describe("openai-compat embed()", () => {
  it("POSTs {baseURL}/embeddings with wire body and normalises the response", async () => {
    const calls = stubFetch(200, {
      object: "list",
      model: "emb",
      data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });
    const res = await provider().embed({ metadata: {} }, { model: "emb", input: ["a", "b"], dimensions: 2, user: "u" });
    expect(calls[0]!.url).toBe("https://up.example/v1/embeddings");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-x");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "emb",
      input: ["a", "b"],
      dimensions: 2,
      user: "u",
    });
    expect(res.provider).toBe("p");
    expect(res.data[0]!.embedding).toEqual([0.1, 0.2]);
    expect(res.usage.promptTokens).toBe(4);
    expect(res.usage.totalTokens).toBe(4);
  });

  it("throws ProviderError with upstream status on failure", async () => {
    stubFetch(429, { error: { message: "slow down" } });
    const err = await provider()
      .embed({ metadata: {} }, { model: "emb", input: "a" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).statusCode).toBe(429);
  });
});

describe("openai-compat generateImage()", () => {
  it("POSTs {baseURL}/images/generations with snake_case body and normalises the response", async () => {
    const calls = stubFetch(200, { created: 7, data: [{ b64_json: "AAA", revised_prompt: "cat!" }] });
    const res = await provider().generateImage(
      { metadata: {} },
      { model: "img", prompt: "cat", n: 1, size: "256x256", responseFormat: "b64_json" },
    );
    expect(calls[0]!.url).toBe("https://up.example/v1/images/generations");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "img",
      prompt: "cat",
      n: 1,
      size: "256x256",
      response_format: "b64_json",
    });
    expect(res.created).toBe(7);
    expect(res.data[0]).toEqual({ b64Json: "AAA", revisedPrompt: "cat!" });
  });
});

describe("/v1/embeddings and /v1/images/generations end-to-end", () => {
  const cfg = {
    auth: { enabled: false },
    strategy: { mode: "single", targets: ["t"] },
    targets: [
      {
        name: "t",
        provider: "openai",
        apiKey: "sk",
        baseURL: "https://up.example/v1",
        models: ["text-embedding-3-small", "dall-e-3"],
      },
    ],
  } as GatewayConfig;

  it("built-in openai target serves embeddings in OpenAI wire format", async () => {
    stubFetch(200, {
      object: "list",
      model: "text-embedding-3-small",
      data: [{ object: "embedding", embedding: [1, 2, 3], index: 0 }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });
    const app = createApp(new Gateway(cfg), cfg);
    const r = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "hi" }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, any>;
    expect(j).toEqual({
      object: "list",
      data: [{ object: "embedding", embedding: [1, 2, 3], index: 0 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });
  });

  it("built-in openai target serves images with snake_case in/out", async () => {
    const calls = stubFetch(200, { created: 9, data: [{ b64_json: "Zm9v" }] });
    const app = createApp(new Gateway(cfg), cfg);
    const r = await app.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", response_format: "b64_json" }),
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(String(calls[0]!.init.body))["response_format"]).toBe("b64_json");
    expect(await r.json()).toEqual({ created: 9, data: [{ b64_json: "Zm9v" }] });
  });

  it("maps upstream errors instead of answering 500 (upstream 401 -> 502 upstream_auth_failed)", async () => {
    stubFetch(401, { error: { message: "bad key" } });
    const app = createApp(new Gateway(cfg), cfg);
    const r = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "hi" }),
    });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("upstream_auth_failed");
  });
});

describe("openai-compat chat request body (H1 passthrough)", () => {
  it("forwards parallel_tool_calls and json_schema response_format upstream", async () => {
    const calls = stubFetch(200, { id: "1", choices: [], usage: {} });
    await provider().complete(
      { metadata: {} },
      {
        model: "emb",
        messages: [{ role: "user", content: "x" }],
        parallelToolCalls: false,
        responseFormat: { type: "json_schema", jsonSchema: { name: "s", schema: { type: "object" } } },
      },
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "s", schema: { type: "object" } },
    });
  });
});
