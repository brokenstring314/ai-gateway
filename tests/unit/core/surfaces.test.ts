// Plan 2.6 / 2.8: completions + passthrough surfaces, wire pass-through allow-list.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  chatLogprobsToLegacy,
  createTextCompletionStreamSerializer,
  parseCompletionsRequest,
  toTextCompletionResponse,
} from "@/core/surfaces/completions";
import { applyPassthroughMaxTokens, compileRouteAllowlist, passthroughTokenField } from "@/core/surfaces/passthrough";
import { attachWireRequestExtras } from "@/handlers/openai-wire";
import type { ChatCompletionRequest } from "@/providers/types";
import { normalizeWireUsage, pickExtras } from "@/providers/wire-extras";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { parseConfig as validateConfig } from "@/config/schema";
import type { GatewayConfig } from "@/config/types";

describe("completions surface (T3-7)", () => {
  it("maps snake_case params and legacy integer logprobs onto the chat request", () => {
    const p = parseCompletionsRequest({
      model: "m",
      prompt: ["hi"],
      max_tokens: 5,
      top_p: 0.5,
      presence_penalty: 1,
      logprobs: 2,
      stream_options: { include_usage: true },
      top_k: 4,
      bogus: 1,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.request).toMatchObject({
      maxTokens: 5,
      topP: 0.5,
      presencePenalty: 1,
      logprobs: true,
      topLogprobs: 2,
      streamOptions: { includeUsage: true },
    });
    expect(p.request.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(p.request.extra).toEqual({ top_k: 4 });
  });
  it("camelCase is still accepted", () => {
    const p = parseCompletionsRequest({ model: "m", prompt: "hi", maxTokens: 7 });
    expect(p.ok && p.request.maxTokens).toBe(7);
  });
  it("rejects what chat cannot express instead of ignoring it", () => {
    for (const extra of [{ prompt: ["a", "b"] }, { echo: true }, { suffix: "x" }, { best_of: 3 }]) {
      expect(parseCompletionsRequest({ model: "m", prompt: "hi", ...extra }).ok).toBe(false);
    }
    expect(parseCompletionsRequest({ model: "m", prompt: "hi", echo: false, best_of: 1, suffix: null }).ok).toBe(true);
  });
  it("serialises text_completion with legacy logprobs", () => {
    const out = toTextCompletionResponse({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "m",
      provider: "p",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ab" },
          finishReason: "stop",
          logprobs: {
            content: [
              { token: "a", logprob: -1, top_logprobs: [{ token: "a", logprob: -1 }] },
              { token: "b", logprob: -2 },
            ],
          },
        },
      ],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      extra: { system_fingerprint: "fp" },
    }) as any;
    expect(out).toMatchObject({ object: "text_completion", system_fingerprint: "fp", usage: { prompt_tokens: 1 } });
    expect(out.choices[0]).toEqual({
      text: "ab",
      index: 0,
      finish_reason: "stop",
      logprobs: { tokens: ["a", "b"], token_logprobs: [-1, -2], top_logprobs: [{ a: -1 }, null], text_offset: [0, 1] },
    });
    expect(chatLogprobsToLegacy(null)).toBeNull();
  });
  it("stream serialiser emits text chunks and keeps text_offset across chunks", () => {
    const ser = createTextCompletionStreamSerializer();
    ser({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", content: "he" }, finishReason: "" }],
    });
    const second = ser({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "y" },
          finishReason: "stop",
          logprobs: { content: [{ token: "y", logprob: -0.5 }] },
        },
      ],
    }) as any;
    expect(second.object).toBe("text_completion");
    expect(second.choices[0]).toMatchObject({ text: "y", finish_reason: "stop", logprobs: { text_offset: [2] } });
  });
});

describe("wire pass-through allow-list (T3-9 fields, T3-11)", () => {
  it("only allow-listed keys survive", () => {
    expect(pickExtras({ reasoning_effort: "high", api_key: "x" }, ["reasoning_effort"])).toEqual({
      reasoning_effort: "high",
    });
    expect(pickExtras({ api_key: "x" }, ["reasoning_effort"])).toBeUndefined();
  });
  it("usage details and extras are kept", () => {
    expect(
      normalizeWireUsage({
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
        prompt_tokens_details: { cached_tokens: 1 },
        cost: 0.1,
        junk: 1,
      }),
    ).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      promptTokensDetails: { cached_tokens: 1 },
      extra: { cost: 0.1 },
    });
  });
  it("request + message extras are re-attached after schema validation", () => {
    const req: ChatCompletionRequest = attachWireRequestExtras(
      {
        reasoning_effort: "low",
        messages: [
          { role: "assistant", content: "a", reasoning_content: "r" },
          { role: "user", content: "b" },
        ],
      },
      {
        model: "m",
        messages: [
          { role: "assistant" as const, content: "a" },
          { role: "user" as const, content: "b" },
        ],
      },
    );
    expect(req.extra).toEqual({ reasoning_effort: "low" });
    expect(req.messages[0]!.extra).toEqual({ reasoning_content: "r" });
    expect(req.messages[1]!.extra).toBeUndefined();
  });
});

describe("passthrough surface (S3-6)", () => {
  it("default allow-list: stateless POST only", () => {
    const allowed = compileRouteAllowlist();
    expect(allowed("POST", "/v1/responses")).toBe(true);
    expect(allowed("POST", "/v1/moderations")).toBe(true);
    expect(allowed("POST", "/v1/audio/transcriptions")).toBe(true);
    expect(allowed("POST", "/v1/audio")).toBe(false);
    expect(allowed("GET", "/v1/responses/resp_1")).toBe(false);
    expect(allowed("POST", "/v1/responses/resp_1/cancel")).toBe(false);
    expect(allowed("DELETE", "/v1/files/f")).toBe(false);
    expect(allowed("GET", "/v1/files")).toBe(false);
    expect(allowed("POST", "/v1/audio%2F..%2Ffiles")).toBe(false);
  });
  it("configured routes replace the default; malformed entries throw", () => {
    const allowed = compileRouteAllowlist(["GET /v1/files", "* /v1/batches/*"]);
    expect(allowed("GET", "/v1/files")).toBe(true);
    expect(allowed("DELETE", "/v1/batches/b1")).toBe(true);
    expect(allowed("POST", "/v1/responses")).toBe(false);
    expect(() => compileRouteAllowlist(["/v1/files"])).toThrow();
  });
  it("token field mapping and write-back", () => {
    expect(passthroughTokenField("/v1/responses", {})).toBe("max_output_tokens");
    expect(passthroughTokenField("/v1/moderations", {})).toBeUndefined();
    expect(passthroughTokenField("/v1/x", { max_tokens: 9 })).toBe("max_tokens");
    expect(applyPassthroughMaxTokens({ max_output_tokens: 5 }, "max_output_tokens", 10)).toBeUndefined();
    expect(JSON.parse(applyPassthroughMaxTokens({ a: 1 }, "max_output_tokens", 10)!)).toEqual({
      a: 1,
      max_output_tokens: 10,
    });
  });
  it("config schema validates passthroughProxy.routes", () => {
    const base = {
      targets: [{ name: "t", provider: "openai", apiKey: "k" }],
      strategy: { mode: "single", targets: ["t"] },
    };
    expect(() =>
      validateConfig({
        ...base,
        passthroughProxy: { enabled: true, routes: ["POST /v1/responses", "POST /v1/audio/*"] },
      }),
    ).not.toThrow();
    expect(() => validateConfig({ ...base, passthroughProxy: { enabled: true, routes: ["responses"] } })).toThrow();
  });
});

describe("passthrough HTTP (S3-6)", () => {
  let calls: { method: string; url: string; body?: string }[] = [];
  let fetchSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    calls = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (u: string, init: RequestInit) => {
      calls.push({
        method: String(init?.method),
        url: String(u),
        body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : undefined,
      });
      return Response.json({ id: "resp_1", object: "response" });
    }) as unknown as typeof fetch);
  });
  afterEach(() => fetchSpy.mockRestore());

  function app(passthroughProxy: GatewayConfig["passthroughProxy"], plugins: unknown[] = []) {
    const config = {
      auth: { enabled: false },
      strategy: { mode: "single", targets: ["t"] },
      targets: [{ name: "t", provider: "openai", apiKey: "sk", baseURL: "https://up.example/v1", models: ["gpt-4o"] }],
      passthroughProxy,
      plugins,
    } as unknown as GatewayConfig;
    return createApp(new Gateway(config), config);
  }

  it("non-POST on gateway-owned routes is 405 with Allow, proxy on or off", async () => {
    for (const pp of [{ enabled: true }, { enabled: false }]) {
      const a = app(pp);
      for (const [method, path, allow] of [
        ["GET", "/v1/chat/completions", "POST"],
        ["DELETE", "/v1/completions", "POST"],
        ["PUT", "/v1/embeddings", "POST"],
        ["POST", "/v1/models", "GET, HEAD"],
      ] as const) {
        const r = await a.request(path, { method, headers: { "x-provider": "t" } });
        expect(r.status).toBe(405);
        expect(r.headers.get("allow")).toBe(allow);
      }
    }
    expect(calls).toEqual([]);
  });
  it("non-allow-listed route is 403 route_not_allowed and never forwarded", async () => {
    const r = await app({ enabled: true }).request("/v1/files", { method: "GET", headers: { "x-provider": "t" } });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe("route_not_allowed");
    expect(calls).toEqual([]);
  });
  it("max-token caps / injects max_output_tokens on proxied /v1/responses", async () => {
    const a = app({ enabled: true }, [{ name: "max-token", config: { maxTokens: 10 } }]);
    await a.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hi", max_output_tokens: 100000 }),
    });
    await a.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
    });
    await a.request("/v1/moderations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
    });
    expect(JSON.parse(calls[0]!.body!).max_output_tokens).toBe(10);
    expect(JSON.parse(calls[1]!.body!).max_output_tokens).toBe(10);
    expect(JSON.parse(calls[2]!.body!)).toEqual({ model: "gpt-4o", input: "hi" });
  });
});

describe("completionsSurface (core/types Surface)", () => {
  it("is a chat-capability surface that round-trips the plugin view", async () => {
    const { completionsSurface: s } = await import("@/core/surfaces/completions");
    const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 3 };
    expect(s.name).toBe("completions");
    expect(s.capability).toBe("chat");
    expect(s.withModel(req, "x").model).toBe("x");
    expect(s.applyPluginView(req, { ...s.toPluginView(req), maxTokens: 2 }).maxTokens).toBe(2);
  });
});
