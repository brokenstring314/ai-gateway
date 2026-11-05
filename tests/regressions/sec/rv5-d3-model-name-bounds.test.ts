/**
 * Red team 2026-11-05 D3: the requested model name was unbounded and written
 * verbatim into request_logs (model + error_message), usage rows (one per
 * distinct name) and stdout; 5 × 9 MB names added ~352 MB on disk. Such
 * requests also skipped the key's RPM (the model check ran before the key
 * meter), so a key with RPM 2 and an exhausted quota could repeat them freely
 * (repros/abuse-data/t4_model_name_amplification.sh, t9_rpm_not_applied_to_bad_model.sh).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { MAX_MODEL_NAME_LENGTH } from "@/core/request-limits";
import { Gateway } from "@/gateway";
import type { RequestLogEntry } from "@/observability/request-log";
import { KeyStore } from "@/persistence/key-store";
import { chatJson, fakeFetch, target } from "../core/_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

async function setup(limits: { rpm?: number; quotaTokens?: number } = {}) {
  const f = fakeFetch(() => chatJson("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
  restore = f.restore;
  const config = loadConfigFromObject({
    strategy: { mode: "single" },
    targets: [target("a")],
    auth: { enabled: true },
    passthroughProxy: { enabled: true },
  });
  const gw = new Gateway(config);
  const logs: RequestLogEntry[] = [];
  gw.addRequestLogSink((e) => logs.push(e));
  const store = await KeyStore.create(new Database(":memory:"));
  const key = store.create("k", ["inference"], undefined, limits).key;
  const app = createApp(gw, config, undefined, store);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { post, logs, calls: f.calls };
}

const chat = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }] });

describe("D3 model name bounds", () => {
  it(`a model name over ${MAX_MODEL_NAME_LENGTH} characters is a 400 invalid_model_name; nothing large is logged`, async () => {
    const { post, logs, calls } = await setup();
    const name = `m${"a ".repeat(4_500_000)}`; // the t4 repro: 9 MB, spaces to dodge the old D1 regex
    const t0 = performance.now();
    const r = await post("/v1/chat/completions", chat(name));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string; message: string; param: string } };
    expect(body.error.code).toBe("invalid_model_name");
    expect(body.error.param).toBe("model");
    expect(body.error.message.length).toBeLessThan(300);
    expect(calls.length).toBe(0);
    expect(logs.length).toBe(1);
    const size = JSON.stringify(logs[0]).length;
    expect(size).toBeLessThan(2000); // was ≥ 18 MB per entry (model + error message)
    expect(logs[0]!.publishedModel).toBe("(unknown)");
    expect(logs[0]!.status).toBe(400);
  });

  it("exactly 256 characters is accepted as a name (then 404 when not published)", async () => {
    const { post } = await setup();
    const ok = await post("/v1/chat/completions", chat("x".repeat(MAX_MODEL_NAME_LENGTH)));
    expect(ok.status).toBe(404);
    const over = await post("/v1/chat/completions", chat("x".repeat(MAX_MODEL_NAME_LENGTH + 1)));
    expect(over.status).toBe(400);
  });

  it("control and bidi characters in a model name are a 400", async () => {
    const { post } = await setup();
    for (const bad of ["m\n", "m\u0000", "m\u202e", "m\u2028", "m\u0085"]) {
      const r = await post("/v1/chat/completions", chat(bad));
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("invalid_model_name");
    }
  });

  it("embeddings, completions, images and pass-through bodies are bounded the same way", async () => {
    const { post } = await setup();
    const long = "z".repeat(MAX_MODEL_NAME_LENGTH + 1);
    for (const [path, body] of [
      ["/v1/embeddings", { model: long, input: "x" }],
      ["/v1/completions", { model: long, prompt: "x" }],
      ["/v1/images/generations", { model: long, prompt: "x" }],
      ["/v1/responses", { model: long, input: "x" }],
    ] as const) {
      const r = await post(path, body);
      expect([path, r.status]).toEqual([path, 400]);
    }
  });

  it("unknown model names count toward the key's RPM (t9 repro: six 404s, no 429 before)", async () => {
    const { post } = await setup({ rpm: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post("/v1/chat/completions", chat(`nope-${i}`))).status);
    expect(statuses.slice(0, 2)).toEqual([404, 404]);
    expect(statuses.slice(2).every((s) => s === 429)).toBe(true);
  });

  it("over-long names count toward the key's RPM too", async () => {
    const { post } = await setup({ rpm: 1 });
    const long = "q".repeat(10_000);
    expect((await post("/v1/chat/completions", chat(long))).status).toBe(400);
    expect((await post("/v1/chat/completions", chat(long))).status).toBe(429);
  });

  it("each made-up name does not get its own usage row: failed requests on unpublished names log publishedModel (unknown)", async () => {
    const { post, logs } = await setup();
    for (let i = 0; i < 3; i++) await post("/v1/chat/completions", chat(`made-up-${i}`));
    expect(logs.map((l) => l.publishedModel)).toEqual(["(unknown)", "(unknown)", "(unknown)"]);
    // request_logs keep what was asked for (bounded).
    expect(logs.map((l) => l.model)).toEqual(["made-up-0", "made-up-1", "made-up-2"]);
  });

  it("a long X-Request-Id is cut in the log entry", async () => {
    const { logs } = await setup();
    const config = loadConfigFromObject({
      strategy: { mode: "single" },
      targets: [target("a")],
      auth: { enabled: false },
    });
    const gw = new Gateway(config);
    gw.addRequestLogSink((e) => logs.push(e));
    const app = createApp(gw, config);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "r".repeat(8000) },
      body: JSON.stringify(chat("m")),
    });
    expect(logs.at(-1)!.requestId.length).toBeLessThan(300);
  });
});
