// Regression: requests rejected or short-circuited by a before-request plugin
// (route(), routeStream(), embeddings, images, pass-through proxy) wrote no
// request-log entry and no metrics. Each must now be logged exactly once with
// its status, the plugin's name and no upstream target (provider "none").
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { initRequestLogger, type RequestLogEntry } from "@/observability/request-log";
import { getMetrics } from "@/metrics/metrics";
import { cfg, mockProvider, newCalls } from "./_repro-helpers";

let entries: RequestLogEntry[];
let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  entries = [];
  const logger = initRequestLogger();
  spyOn(logger, "logRequest").mockImplementation(async (e: RequestLogEntry) => {
    entries.push(e);
  });
  getMetrics().reset();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
  initRequestLogger();
});

function setup(plugins: unknown[]) {
  const calls = newCalls();
  const c = cfg({ plugins, auth: { enabled: false }, passthroughProxy: { enabled: true } } as never);
  const gw = new Gateway(c);
  gw.registerProvider(mockProvider(calls));
  return { app: createApp(gw, c), gw, calls };
}
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Request-Id": "req-1" },
    body: JSON.stringify(body),
  });

const wordFilter = [{ name: "word-filter", config: { blockedWords: ["forbidden"] } }];
const chat = (stream: boolean) => ({
  model: "gpt-4o",
  stream,
  messages: [{ role: "user", content: "forbidden words" }],
});

async function expectOneRejection(surface: string, plugin = "word-filter", status = 403) {
  expect(entries.length).toBe(1);
  const e = entries[0]!;
  expect(e.status).toBe(status);
  expect(e.plugin).toBe(plugin);
  expect(e.provider).toBe("none");
  expect(e.outcome).toBe("plugin_rejected");
  expect(e.surface).toBe(surface);
  expect(e.requestId).toBe("req-1");
  expect(e.error).toBeTruthy();
  expect(await getMetrics().format()).toContain(
    `ai_gateway_plugin_blocked_total{plugin="${plugin}",outcome="plugin_rejected",surface="${surface}"} 1`,
  );
}

describe("plugin-blocked requests are logged once", () => {
  it("route(): rejection", async () => {
    const { app, calls } = setup(wordFilter);
    expect((await post(app, "/v1/chat/completions", chat(false))).status).toBe(403);
    expect(calls.chat.length).toBe(0);
    await expectOneRejection("chat");
  });

  it("routeStream(): rejection", async () => {
    const { app, calls } = setup(wordFilter);
    expect((await post(app, "/v1/chat/completions", chat(true))).status).toBe(403);
    expect(calls.chat.length).toBe(0);
    await expectOneRejection("chat_stream");
  });

  it("embeddings: rejection", async () => {
    const { app, calls } = setup(wordFilter);
    expect((await post(app, "/v1/embeddings", { model: "gpt-4o", input: "forbidden" })).status).toBe(403);
    expect(calls.embed.length).toBe(0);
    await expectOneRejection("embedding");
  });

  it("images: rejection", async () => {
    const { app, calls } = setup(wordFilter);
    expect((await post(app, "/v1/images/generations", { model: "gpt-4o", prompt: "forbidden" })).status).toBe(403);
    expect(calls.image.length).toBe(0);
    await expectOneRejection("image");
  });

  it("pass-through proxy: rejection", async () => {
    const { app } = setup(wordFilter);
    expect((await post(app, "/v1/responses", { model: "gpt-4o", input: "forbidden" })).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectOneRejection("passthrough");
  });

  it("rate-limit rejection names the rate-limit plugin", async () => {
    const { app } = setup([{ name: "rate-limit", config: { keyRpm: 1 } }]);
    const ok = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    expect((await post(app, "/v1/chat/completions", ok)).status).toBe(200);
    entries = [];
    getMetrics().reset();
    // Rate-limit (and budget) rejections answer 429, not 403.
    const r = await post(app, "/v1/chat/completions", ok);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    await expectOneRejection("chat", "rate-limit", 429);
  });

  it("route(): short-circuit served by a plugin is logged once with status 200", async () => {
    const { app, gw, calls } = setup([]);
    gw.registerPlugin("before_request", {
      name: "canned",
      stage: "before_request",
      execute: async () => ({
        action: "short_circuit",
        response: {
          id: "c",
          object: "chat.completion",
          created: 1,
          model: "gpt-4o",
          provider: "canned",
          choices: [{ index: 0, message: { role: "assistant", content: "cached" }, finishReason: "stop" }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        } as never,
      }),
    });
    expect(
      (await post(app, "/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }))
        .status,
    ).toBe(200);
    expect(calls.chat.length).toBe(0);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      status: 200,
      plugin: "canned",
      provider: "none",
      outcome: "plugin_short_circuit",
      surface: "chat",
    });
    expect(await getMetrics().format()).toContain(
      'ai_gateway_plugin_blocked_total{plugin="canned",outcome="plugin_short_circuit",surface="chat"} 1',
    );
  });

  it("short-circuit on a stream / embedding without response is logged once as a 403 naming the plugin", async () => {
    const { app, gw } = setup([]);
    gw.registerPlugin("before_request", {
      name: "sc",
      stage: "before_request",
      execute: async () => ({ action: "short_circuit", response: {} as never }),
    });
    expect(
      (await post(app, "/v1/chat/completions", { ...chat(true), messages: [{ role: "user", content: "hi" }] })).status,
    ).toBe(403);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ status: 403, plugin: "sc", provider: "none", surface: "chat_stream" });
    entries = [];
    expect((await post(app, "/v1/embeddings", { model: "gpt-4o", input: "x" })).status).toBe(403);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ status: 403, plugin: "sc", provider: "none", surface: "embedding" });
  });

  it("pass-through content modification is logged once naming the modifying plugin", async () => {
    const { app } = setup([{ name: "word-filter", config: { blockedWords: ["secret"], mode: "redact" } }]);
    expect((await post(app, "/v1/responses", { model: "gpt-4o", input: "my secret" })).status).toBe(403);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ status: 403, plugin: "word-filter", provider: "none", surface: "passthrough" });
  });
});
