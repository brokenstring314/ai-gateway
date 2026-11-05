/**
 * Red team 2026-11-05 F4: pass-through routes never checked the body's output
 * limit, so with limits.maxOutputTokens: 1000 (or a model's published
 * maxOutputTokens) `POST /v1/responses {"max_output_tokens": 9999999}` was
 * forwarded as-is while chat answered 400 (repros/fixes/zz-rv5a-f4-passthrough.test.ts).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import { KeyStore } from "@/persistence/key-store";
import { fakeFetch, target } from "../core/_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

async function setup(extra: Record<string, unknown>) {
  const f = fakeFetch(() =>
    Response.json({
      id: "r",
      object: "response",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  );
  restore = f.restore;
  const config = loadConfigFromObject({
    strategy: { mode: "single" },
    targets: [target("a", ["m"])],
    auth: { enabled: true },
    passthroughProxy: { enabled: true },
    ...extra,
  });
  const store = await KeyStore.create(new Database(":memory:"));
  const key = store.create("k", ["inference"]).key;
  const app = createApp(new Gateway(config), config, undefined, store);
  const send = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { send, calls: f.calls };
}

type Err = { error: { code: string; param: string; message: string } };

describe("F4 pass-through output limit", () => {
  it("max_output_tokens over limits.maxOutputTokens is a 400 max_tokens_exceeded, never forwarded or clamped", async () => {
    const { send, calls } = await setup({ limits: { maxOutputTokens: 1000 } });
    const chat = await send("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 9_999_999,
    });
    expect(chat.status).toBe(400);
    const r = await send("/v1/responses", { model: "m", input: "hi", max_output_tokens: 9_999_999 }); // was 200
    expect(r.status).toBe(400);
    const body = (await r.json()) as Err;
    expect(body.error.code).toBe("max_tokens_exceeded");
    expect(body.error.param).toBe("max_output_tokens");
    expect(body.error.message).toContain("limits.maxOutputTokens");
    expect(calls.length).toBe(0);
  });

  it("every output-limit field counts: a decoy small field does not hide a large one", async () => {
    const { send, calls } = await setup({ limits: { maxOutputTokens: 1000 } });
    for (const body of [
      { model: "m", input: "hi", max_output_tokens: 10, max_tokens: 50_000 },
      { model: "m", input: "hi", max_completion_tokens: 50_000 },
      { model: "m", input: "hi", max_tokens: 1001 },
    ]) {
      const r = await send("/v1/responses", body);
      expect(r.status).toBe(400);
    }
    expect(
      (
        (await (
          await send("/v1/responses", { model: "m", input: "hi", max_output_tokens: 10, max_tokens: 50_000 })
        ).json()) as Err
      ).error.param,
    ).toBe("max_tokens");
    expect(calls.length).toBe(0);
  });

  it("the model's published maxOutputTokens wins over the global limit; at the limit is forwarded", async () => {
    const { send, calls } = await setup({
      limits: { maxOutputTokens: 100_000 },
      models: [{ name: "pub", bindings: [{ target: "a", model: "m" }], metadata: { maxOutputTokens: 2000 } }],
    });
    const over = await send("/v1/responses", { model: "pub", input: "hi", max_output_tokens: 2001 });
    expect(over.status).toBe(400);
    expect(((await over.json()) as Err).error.message).toContain("outputs at most 2000");
    expect(calls.length).toBe(0);
    const ok = await send("/v1/responses", { model: "pub", input: "hi", max_output_tokens: 2000 });
    expect(ok.status).toBe(200);
  });

  it("within the limit, or with no output limit (moderations), the body is forwarded unchanged", async () => {
    const { send, calls } = await setup({ limits: { maxOutputTokens: 1000 } });
    expect((await send("/v1/responses", { model: "m", input: "hi", max_output_tokens: 1000 })).status).toBe(200);
    expect((await send("/v1/moderations", { model: "m", input: "hi" })).status).toBe(200);
    expect(calls.map((c) => c.body.max_output_tokens)).toEqual([1000, undefined]);
  });
});
