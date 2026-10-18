/**
 * Regression tests: the chat handler speaks the OpenAI wire format.
 *  - H1: snake_case request fields are accepted and mapped to internal types.
 *  - H2: responses / stream chunks are emitted in OpenAI snake_case.
 */
import { describe, it, expect } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import type { GatewayConfig } from "@/config/types";
import type {
  IProvider, IStreamProvider, ChatCompletionRequest, ChatCompletionResponse, RequestContext, StreamChunk,
} from "@/providers/types";
import { createOpenAIWireStreamSerializer, fromOpenAIWireChatRequest } from "@/handlers/openai-wire";

function cfg(): GatewayConfig {
  return {
    auth: { enabled: false }, strategy: { mode: "single", targets: ["mock"] },
    targets: [{ name: "mock", provider: "openai", apiKey: "sk", baseURL: "https://up.example/v1", models: ["gpt-4o"] }],
  } as GatewayConfig;
}

function mockProvider(calls: ChatCompletionRequest[], chunks?: StreamChunk[]): IProvider & IStreamProvider {
  return {
    name: "mock",
    async complete(_c: RequestContext, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      calls.push(req);
      return {
        id: "x", object: "chat.completion", created: 1, model: req.model, provider: "mock",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            toolCalls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          finishReason: "tool_calls",
        }],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      };
    },
    async *completeStream(_c: RequestContext, req: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
      calls.push(req);
      for (const ch of chunks ?? []) yield ch;
    },
    supportedModels: () => ["gpt-4o"],
    supportsModel: (m: string) => m === "gpt-4o",
    models: () => [{ id: "gpt-4o", ownedBy: "mock" }],
  };
}

function setup(chunks?: StreamChunk[]) {
  const calls: ChatCompletionRequest[] = [];
  const gw = new Gateway(cfg());
  gw.registerProvider(mockProvider(calls, chunks));
  return { calls, app: createApp(gw, cfg()) };
}

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("OpenAI wire format — request (snake_case in)", () => {
  it("maps snake_case top-level fields to internal camelCase", async () => {
    const { app, calls } = setup();
    const res = await post(app, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "a" }],
      max_tokens: 5,
      max_completion_tokens: 6,
      top_p: 0.5,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      logit_bias: { "50256": -100 },
      tool_choice: "required",
      parallel_tool_calls: false,
      response_format: { type: "json_schema", json_schema: { name: "s", schema: { type: "object", additional_properties: false } } },
      top_logprobs: 2,
      logprobs: true,
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object", required_fields: ["x"] } } }],
    });
    expect(res.status).toBe(200);
    const req = calls[0]!;
    expect(req.maxTokens).toBe(5);
    expect(req.maxCompletionTokens).toBe(6);
    expect(req.topP).toBe(0.5);
    expect(req.frequencyPenalty).toBe(0.1);
    expect(req.presencePenalty).toBe(0.2);
    expect(req.logitBias).toEqual({ "50256": -100 });
    expect(req.toolChoice).toBe("required");
    expect(req.parallelToolCalls).toBe(false);
    expect(req.topLogprobs).toBe(2);
    expect(req.responseFormat?.type).toBe("json_schema");
    // Opaque schemas are passed through untouched (no key rewriting inside).
    expect(req.responseFormat?.jsonSchema).toEqual({ name: "s", schema: { type: "object", additional_properties: false } });
    expect(req.tools?.[0]?.function.parameters).toEqual({ type: "object", required_fields: ["x"] });
  });

  it("maps tool_calls / tool_call_id / image_url / stream_options and accepts content: null", async () => {
    const { app, calls } = setup([]);
    const res = await post(app, {
      model: "gpt-4o",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "https://x/y.png", detail: "low" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "42" },
      ],
    });
    expect(res.status).toBe(200);
    await res.text();
    const req = calls[0]!;
    expect(req.streamOptions).toEqual({ includeUsage: true });
    const parts = req.messages[0]!.content as { imageUrl?: { url: string; detail?: string } }[];
    expect(parts[1]!.imageUrl).toEqual({ url: "https://x/y.png", detail: "low" });
    expect(req.messages[1]!.toolCalls?.[0]?.id).toBe("c1");
    expect(req.messages[1]!.content).toBeUndefined();
    expect(req.messages[2]!.toolCallId).toBe("c1");
  });

  it("still accepts legacy camelCase fields", () => {
    const out = fromOpenAIWireChatRequest({ model: "m", messages: [], maxTokens: 3, toolChoice: "auto" }) as Record<string, unknown>;
    expect(out["maxTokens"]).toBe(3);
    expect(out["toolChoice"]).toBe("auto");
  });
});

describe("OpenAI wire format — response (snake_case out)", () => {
  it("non-streaming response uses snake_case and drops internal fields", async () => {
    const { app } = setup();
    const res = await post(app, { model: "gpt-4o", messages: [{ role: "user", content: "a" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gateway-Provider")).toBe("mock");
    const j = await res.json() as Record<string, any>;
    expect(j["provider"]).toBeUndefined();
    expect(j["usage"]).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    const choice = j["choices"][0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.finishReason).toBeUndefined();
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }]);
    expect(choice.message.toolCalls).toBeUndefined();
  });

  it("stream chunks: role only on first delta, finish_reason null until final, usage snake_case, [DONE]", async () => {
    const base = { id: "s", object: "chat.completion.chunk", created: 1, model: "gpt-4o" };
    const chunks: StreamChunk[] = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "he" }, finishReason: "" }] },
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "llo" }, finishReason: "" }] },
      { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finishReason: "stop" }] },
      { ...base, choices: [], usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
    ];
    const { app } = setup(chunks);
    const res = await post(app, { model: "gpt-4o", messages: [{ role: "user", content: "a" }], stream: true });
    const text = await res.text();
    const events = text.split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => e.slice(6));
    expect(events.at(-1)).toBe("[DONE]");
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(parsed).toHaveLength(4);
    expect(parsed[0].choices[0].delta).toEqual({ role: "assistant", content: "he" });
    expect(parsed[0].choices[0].finish_reason).toBeNull();
    expect(parsed[1].choices[0].delta).toEqual({ content: "llo" });
    expect(parsed[1].choices[0].finish_reason).toBeNull();
    expect(parsed[2].choices[0].delta).toEqual({});
    expect(parsed[2].choices[0].finish_reason).toBe("stop");
    expect(parsed[3].usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    for (const p of parsed) {
      expect(p.provider).toBeUndefined();
      for (const c of p.choices) expect(c.finishReason).toBeUndefined();
    }
  });

  it("stream tool-call continuation deltas omit empty id/name", () => {
    const toWire = createOpenAIWireStreamSerializer();
    const base = { id: "s", object: "chat.completion.chunk", created: 1, model: "m" };
    toWire({ ...base, choices: [{ index: 0, delta: { role: "assistant", toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: "" } }] }, finishReason: "" }] });
    const second = toWire({ ...base, choices: [{ index: 0, delta: { role: "assistant", toolCalls: [{ id: "", type: "function", function: { name: "", arguments: "{\"a\":" } }] }, finishReason: "" }] }) as any;
    expect(second.choices[0].delta).toEqual({ tool_calls: [{ index: 0, function: { arguments: "{\"a\":" } }] });
  });
});
