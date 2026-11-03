/**
 * 0.3.0 P3: model metadata is enforced before a request leaves the gateway
 * (400 with the reason; never clamped), meaning-preserving rewrites are
 * applied, and published limits must fit inside known upstream limits.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { loadConfigFromObject } from "../../src/config/loader.js";
import { composeConfig } from "../../src/config/runtime-source.js";
import { estimatePromptTokens } from "../../src/core/model-policy.js";
import { completionsSurface } from "../../src/core/surfaces/completions.js";
import { Gateway } from "../../src/gateway.js";
import { ConfigStore } from "../../src/persistence/config-store.js";
import type { ChatCompletionRequest, RequestContext } from "../../src/providers/types.js";
import { SecretBox } from "../../src/secrets/secret-box.js";

const bodies: Array<Record<string, unknown>> = [];
const up = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    bodies.push(body);
    if (new URL(req.url).pathname.endsWith("/completions") && !new URL(req.url).pathname.includes("chat")) {
      return Response.json({
        id: "t",
        object: "text_completion",
        created: 1,
        model: body["model"],
        choices: [{ index: 0, text: "ok", finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    return Response.json({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: body["model"],
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});
let savedNoProxy: string | undefined;
beforeAll(() => {
  savedNoProxy = process.env["NO_PROXY"];
  process.env["NO_PROXY"] = "127.0.0.1,localhost";
});
afterAll(() => {
  up.stop(true);
  if (savedNoProxy === undefined) delete process.env["NO_PROXY"];
  else process.env["NO_PROXY"] = savedNoProxy;
});
beforeEach(() => {
  bodies.length = 0;
});

const base = `http://127.0.0.1:${up.port}/v1`;
const ctx = (): RequestContext => ({ metadata: {} });

function config(extra: Record<string, unknown> = {}) {
  return loadConfigFromObject({
    strategy: { mode: "single", targets: ["ds"] },
    targets: [
      { name: "ds", provider: "deepseek", apiKey: "sk-ds", baseURL: base },
      { name: "oa", provider: "openai", apiKey: "sk-oa", baseURL: base },
    ],
    models: [
      {
        name: "strict",
        bindings: [{ target: "oa", model: "up-strict" }],
        metadata: {
          contextWindow: 1000,
          maxOutputTokens: 100,
          inputModalities: ["text"],
          tools: false,
          parallelTools: false,
          structuredOutput: "json_object",
          logprobs: false,
          webSearch: false,
          reasoning: false,
        },
      },
      {
        name: "think",
        bindings: [{ target: "ds", model: "deepseek-flash", params: { user_tag: "gw" } }],
        metadata: {
          reasoning: {
            efforts: ["none", "low", "high", "max"],
            map: {
              none: { thinking: { type: "disabled" } },
              high: { reasoning_effort: "high", thinking: { type: "enabled" } },
            },
          },
        },
      },
      { name: "pro", bindings: [{ target: "ds", model: "deepseek-v4-pro" }] },
      { name: "nosys", bindings: [{ target: "oa" }], metadata: { systemMessage: "merge_into_user" } },
      { name: "dev", bindings: [{ target: "oa" }], metadata: { developerRole: "passthrough" } },
      { name: "plain", bindings: [{ target: "oa" }] },
    ],
    ...extra,
  });
}

const chat = (model: string, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({
  model,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

async function rejection(g: Gateway, req: ChatCompletionRequest) {
  const err = await g.route(ctx(), req).catch((e) => e);
  expect(err?.status).toBe(400);
  expect(bodies).toEqual([]);
  return err as { code: string; param: string | null; message: string };
}

describe("limits are enforced, never clamped", () => {
  it("max_tokens / max_completion_tokens over the model limit -> 400 with the limit", async () => {
    const g = new Gateway(config());
    const e = await rejection(g, chat("strict", { maxTokens: 101 }));
    expect(e.code).toBe("max_tokens_exceeded");
    expect(e.param).toBe("max_tokens");
    expect(e.message).toContain("at most 100 tokens");
    const e2 = await rejection(g, chat("strict", { maxCompletionTokens: 500 }));
    expect(e2.param).toBe("max_completion_tokens");
    await g.route(ctx(), chat("strict", { maxTokens: 100 }));
    expect(bodies[0]?.["max_tokens"]).toBe(100);
  });

  it("input + output beyond the context window -> 400 context_length_exceeded", async () => {
    const g = new Gateway(config());
    const e = await rejection(g, chat("strict", { messages: [{ role: "user", content: "x".repeat(4000) }] }));
    expect(e.code).toBe("context_length_exceeded");
    const e2 = await rejection(
      g,
      chat("strict", { messages: [{ role: "user", content: "x".repeat(3600) }], maxTokens: 100 }),
    );
    expect(e2.message).toContain("context window of 1000");
  });

  it("legacy completions check the output limit too", async () => {
    const g = new Gateway(config());
    const err = await g.execute(completionsSurface, chat("strict", { maxTokens: 1000 }), ctx()).catch((e) => e);
    expect(err?.status).toBe(400);
    expect(err?.code).toBe("max_tokens_exceeded");
  });

  it("streams are rejected before any upstream call", async () => {
    const g = new Gateway(config());
    const err = await (async () => {
      for await (const _ of g.routeStream(ctx(), chat("strict", { maxTokens: 999 }))) {
        /* drain */
      }
    })().catch((e) => e);
    expect(err?.status).toBe(400);
    expect(bodies).toEqual([]);
  });
});

describe("capabilities", () => {
  const g = () => new Gateway(config());
  it("rejects what the model cannot do, naming the parameter", async () => {
    const image = chat("strict", {
      messages: [{ role: "user", content: [{ type: "image_url", imageUrl: { url: "https://x/y.png" } }] }],
    });
    expect((await rejection(g(), image)).code).toBe("unsupported_input_modality");
    const tools = chat("strict", { tools: [{ type: "function", function: { name: "f" } }] });
    expect((await rejection(g(), tools)).code).toBe("tools_not_supported");
    expect((await rejection(g(), chat("strict", { parallelToolCalls: true }))).code).toBe(
      "parallel_tool_calls_not_supported",
    );
    const schema = chat("strict", { responseFormat: { type: "json_schema", json_schema: { name: "x" } } as never });
    expect((await rejection(g(), schema)).code).toBe("unsupported_response_format");
    expect((await rejection(g(), chat("strict", { logprobs: true }))).code).toBe("logprobs_not_supported");
    expect((await rejection(g(), chat("strict", { extra: { web_search_options: {} } }))).code).toBe(
      "web_search_not_supported",
    );
    expect((await rejection(g(), chat("strict", { extra: { reasoning_effort: "high" } }))).code).toBe(
      "reasoning_not_supported",
    );
  });

  it("json_object is allowed when the model supports it", async () => {
    await g().route(ctx(), chat("strict", { responseFormat: { type: "json_object" } }));
    expect(bodies.length).toBe(1);
  });
});

describe("rewrites", () => {
  it("maps reasoning_effort to the upstream's parameters and adds binding params", async () => {
    const g = new Gateway(config());
    await g.route(ctx(), chat("think", { extra: { reasoning_effort: "none" } }));
    expect(bodies[0]).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, user_tag: "gw" });
    expect(bodies[0]?.["reasoning_effort"]).toBeUndefined();
    await g.route(ctx(), chat("think", { extra: { reasoning_effort: "high" } }));
    expect(bodies[1]).toMatchObject({ reasoning_effort: "high", thinking: { type: "enabled" } });
    await g.route(ctx(), chat("think", { extra: { reasoning_effort: "low" } }));
    expect(bodies[2]).toMatchObject({ reasoning_effort: "low" });
    const err = await g.route(ctx(), chat("think", { extra: { reasoning_effort: "ultra" } })).catch((e) => e);
    expect(err?.code).toBe("unsupported_reasoning_effort");
    expect(err?.message).toContain("none, low, high, max");
  });

  it("developer messages are sent as system unless the model says passthrough", async () => {
    const g = new Gateway(config());
    const dev = chat("plain", {
      messages: [
        { role: "developer", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });
    await g.route(ctx(), dev);
    expect((bodies[0]?.["messages"] as Array<{ role: string }>)[0]?.role).toBe("system");
    await g.route(ctx(), { ...dev, model: "dev" });
    expect((bodies[1]?.["messages"] as Array<{ role: string }>)[0]?.role).toBe("developer");
  });

  it("system messages merge into the first user message when the model has no system role", async () => {
    const g = new Gateway(config());
    await g.route(
      ctx(),
      chat("nosys", {
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(bodies[0]?.["messages"]).toEqual([{ role: "user", content: "rules\n\nhi" }]);
  });
});

describe("known upstream models", () => {
  it("fill unset metadata: deepseek-v4-pro takes no image input; output limit 393216", async () => {
    const g = new Gateway(config());
    const image = chat("pro", {
      messages: [{ role: "user", content: [{ type: "image_url", imageUrl: { url: "https://x/y.png" } }] }],
    });
    expect((await rejection(g, image)).code).toBe("unsupported_input_modality");
    expect((await rejection(g, chat("pro", { maxTokens: 393_217 }))).code).toBe("max_tokens_exceeded");
    expect(g.modelCatalog().lookup("pro")?.metadata).toMatchObject({
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      inputModalities: ["text"],
    });
  });

  it("published limits must fit inside the upstream's (config error otherwise)", () => {
    const bad =
      (metadata: Record<string, unknown>, model = "deepseek-flash") =>
      () =>
        loadConfigFromObject({
          strategy: { mode: "single", targets: ["ds"] },
          targets: [{ name: "ds", provider: "deepseek", apiKey: "k" }],
          models: [{ name: "m", bindings: [{ target: "ds", model }], metadata }],
        });
    expect(bad({ contextWindow: 2_000_000 })).toThrow(/contextWindow 2000000 exceeds upstream "deepseek-flash"/);
    expect(bad({ maxOutputTokens: 500_000 })).toThrow(/maxOutputTokens 500000 exceeds/);
    expect(bad({ inputModalities: ["text", "image"] }, "deepseek-v4-pro")).toThrow(/does not accept image input/);
    expect(bad({ structuredOutput: "json_schema" })).toThrow(/up to "json_object"/);
    expect(bad({ contextWindow: 128_000, maxOutputTokens: 8192 })).not.toThrow();
  });

  it("an unknown upstream has no metadata checks but the global output limit (RB6)", async () => {
    const g = new Gateway(config());
    expect(g.modelCatalog().lookup("plain")?.metadata).toBeUndefined();
    await expect(g.route(ctx(), chat("plain", { maxTokens: 10_000_000 }))).rejects.toMatchObject({
      status: 400,
      code: "max_tokens_exceeded",
    });
    expect(bodies.length).toBe(0);
    await g.route(ctx(), chat("plain", { maxTokens: 65_536 }));
    expect(bodies.length).toBe(1);
  });
});

describe("store and estimate", () => {
  it("binding params and reasoning metadata survive the config store", async () => {
    const file = config();
    const store = await ConfigStore.create(new Database(":memory:"), await SecretBox.create(new Uint8Array(32)));
    await store.importFromConfig(file);
    expect(composeConfig(file, await store.loadRuntimeSections()).models).toEqual(file.models);
  });

  it("estimates roughly bytes/4 plus message framing", () => {
    expect(estimatePromptTokens({ messages: [{ role: "user", content: "x".repeat(400) }] })).toBe(104);
  });
});
