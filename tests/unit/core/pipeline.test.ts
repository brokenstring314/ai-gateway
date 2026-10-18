// core/pipeline.ts: finalize runs exactly once per request (after/onError
// plugins, one request-log entry, settled callbacks) for every surface and
// outcome; /metrics placement follows observability.metrics.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp, metricsPlacement } from "@/app";
import { getRequestLogger, type RequestLogEntry } from "@/observability/request-log";
import type { IPlugin, PluginContext, PluginResult } from "@/plugins/types";
import type { IProvider } from "@/providers/types";
import { cfg, mockProvider, newCalls } from "../plugins/_repro-helpers";

type Spy = ReturnType<typeof spyOn>;
let spy: Spy;
let entries: RequestLogEntry[];
beforeEach(() => {
  entries = [];
  spy = spyOn(getRequestLogger(), "logRequest").mockImplementation(async (e: RequestLogEntry) => {
    entries.push(e);
  });
});
afterEach(() => spy.mockRestore());

function counting(stage: "after_request" | "on_error", seen: string[]): IPlugin {
  return { name: `spy-${stage}`, stage, execute: async () => { seen.push(stage); return { action: "continue" }; } };
}

function setup(before?: (ctx: PluginContext) => PluginResult, provider?: IProvider) {
  const gw = new Gateway(cfg());
  gw.registerProvider(provider ?? mockProvider(newCalls()));
  const seen: string[] = [];
  const settled: number[] = [];
  gw.registerPlugin("after_request", counting("after_request", seen));
  gw.registerPlugin("on_error", counting("on_error", seen));
  gw.registerPlugin("before_request", {
    name: "probe",
    stage: "before_request",
    execute: async (ctx) => {
      ctx.onSettled?.(() => settled.push(1));
      return before ? before(ctx) : { action: "continue" };
    },
  });
  return { gw, seen, settled };
}

const ctx = () => ({ traceId: "t-1", metadata: {} });
const chatReq = { model: "gpt-4o", messages: [{ role: "user" as const, content: "hi" }] };

function failing(): IProvider {
  const p = mockProvider(newCalls()) as unknown as Record<string, unknown>;
  p["complete"] = async () => { throw Object.assign(new Error("upstream down"), { statusCode: 503 }); };
  p["embed"] = p["complete"];
  return p as unknown as IProvider;
}

describe("finalize matrix", () => {
  it("chat success: after once, one log entry with tokens, settled once", async () => {
    const { gw, seen, settled } = setup();
    await gw.route(ctx(), chatReq);
    expect(seen).toEqual(["after_request"]);
    expect(settled).toEqual([1]);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ surface: "chat", provider: "mock", status: 200, tokens: { total: 2000 } });
  });

  it("chat upstream failure: onError once, one log entry with the error, settled once", async () => {
    const { gw, seen, settled } = setup(undefined, failing());
    await expect(gw.route(ctx(), chatReq)).rejects.toThrow();
    expect(seen).toEqual(["on_error"]);
    expect(settled).toEqual([1]);
    expect(entries.length).toBe(1);
    expect(entries[0]?.error).toContain("upstream down");
    expect(entries[0]?.status).toBeGreaterThanOrEqual(500);
  });

  it("plugin rejection: no after/onError, one log entry, settled once", async () => {
    const { gw, seen, settled } = setup(() => ({ action: "reject", reason: "nope", status: 429 }));
    await expect(gw.route(ctx(), chatReq)).rejects.toThrow("nope");
    expect(seen).toEqual([]);
    expect(settled).toEqual([1]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "plugin_rejected", status: 429, provider: "none" });
  });

  it("chat short-circuit without usage answers 200 over HTTP (was 500), logged once", async () => {
    const { gw, settled } = setup((c) => ({
      action: "short_circuit",
      response: { model: c.request.model, choices: [{ index: 0, message: { role: "assistant", content: "cached" }, finishReason: "stop" }] } as never,
    }));
    const app = createApp(gw, cfg());
    const r = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatReq) });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { choices: { message: { content: string } }[]; usage: { total_tokens: number } };
    expect(j.choices[0]?.message.content).toBe("cached");
    expect(j.usage.total_tokens).toBe(0);
    expect(settled).toEqual([1]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "plugin_short_circuit", status: 200 });
  });

  it("embeddings success and failure: after / onError once, one log entry each", async () => {
    const ok = setup();
    await ok.gw.embedWithPlugins(ctx(), { model: "gpt-4o", input: "x" });
    expect(ok.seen).toEqual(["after_request"]);
    expect(entries.at(-1)).toMatchObject({ surface: "embedding", status: 200 });
    const bad = setup(undefined, failing());
    await expect(bad.gw.embedWithPlugins(ctx(), { model: "gpt-4o", input: "x" })).rejects.toThrow();
    expect(bad.seen).toEqual(["on_error"]);
    expect(entries).toHaveLength(2);
  });

  it("images: one log entry, after plugins see no chat response", async () => {
    let response: unknown = "unset";
    const gw = new Gateway(cfg());
    gw.registerProvider(mockProvider(newCalls()));
    gw.registerPlugin("after_request", { name: "a", stage: "after_request", execute: async (c) => { response = c.response; return { action: "continue" }; } });
    await gw.generateImageWithPlugins(ctx(), { model: "gpt-4o", prompt: "cat" });
    expect(response).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ surface: "image", status: 200 });
  });

  it("request log sinks receive each entry once", async () => {
    const { gw } = setup();
    const sunk: RequestLogEntry[] = [];
    const sink = (e: RequestLogEntry) => sunk.push(e);
    gw.addRequestLogSink(sink);
    gw.addRequestLogSink(sink);
    await gw.route(ctx(), chatReq);
    expect(sunk).toHaveLength(1);
  });
});

describe("metrics placement (observability.metrics)", () => {
  const base = cfg();
  it("no metrics block: main port", () => expect(metricsPlacement(base, 3000)).toBe("main"));
  it("enabled false: off", () => expect(metricsPlacement({ ...base, observability: { metrics: { enabled: false } } } as never, 3000)).toBe("off"));
  it("enabled without port or same port: main", () => {
    expect(metricsPlacement({ ...base, observability: { metrics: { enabled: true } } } as never, 3000)).toBe("main");
    expect(metricsPlacement({ ...base, observability: { metrics: { enabled: true, port: 3000 } } } as never, 3000)).toBe("main");
  });
  it("other port: separate", () => expect(metricsPlacement({ ...base, observability: { metrics: { enabled: true, port: 9090 } } } as never, 3000)).toBe("separate"));
  it("disabled: GET /metrics is not served on the app", async () => {
    const c = { ...base, observability: { metrics: { enabled: false } } } as never;
    const app = createApp(new Gateway(c), c);
    expect((await app.request("/metrics")).status).toBe(404);
    const on = createApp(new Gateway(base), base);
    expect((await on.request("/metrics")).status).toBe(200);
  });
});
