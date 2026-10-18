// pii-secret-guard through the real app + pipeline: wire error shape, what
// reaches the provider, request-log `guardrail` records, plugin_blocked
// metric, and that no matched value appears in a response body, a log entry
// or anything printed to the console.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createApp } from "@/app";
import { Gateway } from "@/gateway";
import { getMetrics } from "@/metrics/metrics";
import { initRequestLogger, type RequestLogEntry } from "@/observability/request-log";
import type { ChatCompletionRequest, IProvider, RequestContext } from "@/providers/types";
import { cfg, mockProvider, newCalls } from "./_repro-helpers";

const cat = (...p: string[]) => p.join("");
const GHP = cat("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
const STRIPE = cat("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc");
const EMAIL = "jane.roe@example.org";
const PHONE = "13812345678";
const SECRETS = [GHP, STRIPE, EMAIL, PHONE];

let entries: RequestLogEntry[];
let printed: string[];
let fetchSpy: ReturnType<typeof spyOn>;
const consoleSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  entries = [];
  printed = [];
  const logger = initRequestLogger();
  spyOn(logger, "logRequest").mockImplementation(async (e: RequestLogEntry) => {
    entries.push(e);
  });
  for (const m of ["log", "warn", "error", "info"] as const) {
    consoleSpies.push(
      spyOn(console, m).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      }),
    );
  }
  getMetrics().reset();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
  for (const s of consoleSpies.splice(0)) s.mockRestore();
  initRequestLogger();
});

function setup(config: Record<string, unknown>, provider?: (calls: ReturnType<typeof newCalls>) => IProvider) {
  const calls = newCalls();
  const plugins = [{ name: "pii-secret-guard", stage: "before_request", config }];
  const c = cfg({ plugins, auth: { enabled: false }, passthroughProxy: { enabled: true } } as never);
  const gw = new Gateway(c);
  gw.registerProvider((provider ?? mockProvider)(calls));
  return { app: createApp(gw, c), calls };
}
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Request-Id": "req-g" },
    body: JSON.stringify(body),
  });
const chat = (content: string, stream = false) => ({
  model: "gpt-4o",
  stream,
  messages: [{ role: "user", content }],
});

function expectNoLeak(...blobs: string[]) {
  const all = [...blobs, JSON.stringify(entries), printed.join("\n")].join("\n");
  for (const s of SECRETS) expect(all).not.toContain(s);
}

describe("pii-secret-guard via the app", () => {
  it("chat block: 400 OpenAI-shaped error, code secret_detected, nothing upstream, logged with entity types", async () => {
    const { app, calls } = setup({});
    const r = await post(app, "/v1/chat/completions", chat(`push with ${GHP} and mail ${EMAIL}`));
    const text = await r.text();
    expect(r.status).toBe(400);
    const body = JSON.parse(text);
    expect(body.error.code).toBe("secret_detected");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("github_token");
    expect(calls.chat).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 400,
      plugin: "pii-secret-guard",
      outcome: "plugin_rejected",
      provider: "none",
      surface: "chat",
      guardrail: [
        { plugin: "pii-secret-guard", direction: "request", action: "blocked", entities: ["email", "github_token"] },
      ],
    });
    expect(await getMetrics().format()).toContain(
      'ai_gateway_plugin_blocked_total{plugin="pii-secret-guard",outcome="plugin_rejected",surface="chat"} 1',
    );
    expectNoLeak(text);
  });

  it("streaming chat request is screened too (chat_stream)", async () => {
    const { app, calls } = setup({});
    const r = await post(app, "/v1/chat/completions", chat(`key ${STRIPE}`, true));
    expect(r.status).toBe(400);
    expect(calls.chat).toHaveLength(0);
    expect(entries[0]?.surface).toBe("chat_stream");
    expectNoLeak(await r.text());
  });

  it("chat redact: provider sees placeholders; log says redacted", async () => {
    const { app, calls } = setup({ action: "redact" });
    const r = await post(app, "/v1/chat/completions", chat(`mail ${EMAIL}, call ${PHONE}, key ${GHP}`));
    expect(r.status).toBe(200);
    expect(calls.chat[0]!.messages[0]!.content).toBe("mail [EMAIL], call [PHONE], key [SECRET:github_token]");
    expect(entries[0]?.guardrail?.[0]).toMatchObject({
      action: "redacted",
      entities: ["email", "github_token", "phone"],
    });
    expectNoLeak(await r.text(), JSON.stringify(calls.chat));
  });

  it("completions prompt is redacted", async () => {
    const { app, calls } = setup({ action: "redact" });
    const r = await post(app, "/v1/completions", { model: "gpt-4o", prompt: `reach me at ${EMAIL}` });
    expect(r.status).toBe(200);
    expect(calls.chat[0]!.messages[0]!.content).toBe("reach me at [EMAIL]");
  });

  it("embeddings input (array) is redacted", async () => {
    const { app, calls } = setup({ action: "redact" });
    const r = await post(app, "/v1/embeddings", { model: "gpt-4o", input: [`a ${EMAIL}`, "clean"] });
    expect(r.status).toBe(200);
    expect((calls.embed[0] as { input: string[] }).input).toEqual(["a [EMAIL]", "clean"]);
  });

  it("surfaces: embeddings excluded → forwarded untouched", async () => {
    const { app, calls } = setup({ action: "redact", surfaces: ["chat"] });
    await post(app, "/v1/embeddings", { model: "gpt-4o", input: `a ${EMAIL}` });
    expect((calls.embed[0] as { input: string }).input).toBe(`a ${EMAIL}`);
  });

  it("pass-through + redact → 400 pii_detected, nothing forwarded", async () => {
    const { app } = setup({ action: "redact" });
    const r = await post(app, "/v1/responses", { model: "gpt-4o", input: `mail ${EMAIL}` });
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(JSON.parse(text).error.code).toBe("pii_detected");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(entries[0]).toMatchObject({ plugin: "pii-secret-guard", surface: "passthrough" });
    expectNoLeak(text);
  });

  it("log-only: forwarded unchanged, guardrail record in the log", async () => {
    const { app, calls } = setup({ action: "log" });
    const r = await post(app, "/v1/chat/completions", chat(`mail ${EMAIL}`));
    expect(r.status).toBe(200);
    expect(calls.chat[0]!.messages[0]!.content).toBe(`mail ${EMAIL}`);
    expect(entries[0]?.guardrail).toEqual([
      { plugin: "pii-secret-guard", direction: "request", action: "logged", entities: ["email"] },
    ]);
    // The request log itself must not hold the value even in log-only mode.
    expect(JSON.stringify(entries)).not.toContain(EMAIL);
  });

  describe("response direction", () => {
    const leaky = (calls: ReturnType<typeof newCalls>): IProvider => {
      const base = mockProvider(calls);
      return {
        ...base,
        async complete(_c: RequestContext, req: ChatCompletionRequest) {
          calls.chat.push(req);
          return {
            id: "x",
            object: "chat.completion",
            created: 1,
            model: req.model,
            provider: "mock",
            choices: [
              { index: 0, message: { role: "assistant", content: `the key is ${STRIPE}` }, finishReason: "stop" },
            ],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      } as IProvider;
    };

    it("block: 422 secret_detected, value not returned, logged and counted", async () => {
      const { app, calls } = setup({ direction: "both" }, leaky);
      const r = await post(app, "/v1/chat/completions", chat("what is the key?"));
      const text = await r.text();
      expect(r.status).toBe(422);
      expect(JSON.parse(text).error.code).toBe("secret_detected");
      expect(calls.chat).toHaveLength(1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        status: 422,
        plugin: "pii-secret-guard",
        guardrail: [{ direction: "response", action: "blocked", entities: ["stripe_key"] }],
      });
      expect(await getMetrics().format()).toContain(
        'ai_gateway_plugin_blocked_total{plugin="pii-secret-guard",outcome="response_rejected",surface="chat"} 1',
      );
      expectNoLeak(text);
    });

    it("redact: client receives the placeholder", async () => {
      const { app } = setup({ direction: "response", action: "redact" }, leaky);
      const r = await post(app, "/v1/chat/completions", chat("what is the key?"));
      expect(r.status).toBe(200);
      const body = (await r.json()) as { choices: { message: { content: string }; text: string }[] };
      expect(body.choices[0]!.message.content).toBe("the key is [SECRET:stripe_key]");
    });

    it("completions response is redacted too", async () => {
      const { app } = setup({ direction: "response", action: "redact" }, leaky);
      const r = await post(app, "/v1/completions", { model: "gpt-4o", prompt: "key?" });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { choices: { message: { content: string }; text: string }[] };
      expect(body.choices[0]!.text).toBe("the key is [SECRET:stripe_key]");
    });
  });
});
