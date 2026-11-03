/**
 * RB6 (red team 2026-11-02) — fixed: a published model without metadata did
 * not check max_tokens at all. PoC: max_tokens=9,999,999 → 200, upstream
 * billed 10,000,007 tokens in one request (unbounded for keys without a
 * quota). Now every model without a published maxOutputTokens is held to
 * limits.maxOutputTokens (default 65536): over it is 400
 * max_tokens_exceeded, never clamped; a model's own metadata still wins.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { completionsSurface } from "@/core/surfaces/completions";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "@/config/types";
import { chatJson, fakeFetch, makeGateway, target } from "./_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const msg = [{ role: "user" as const, content: "hi" }];
const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function upstream() {
  const f = fakeFetch(() => chatJson("ok", USAGE));
  restore = f.restore;
  return f;
}

async function errorOf(p: Promise<unknown>): Promise<{ status?: number; code?: string; param?: string } | "ok"> {
  return p.then(
    () => "ok" as const,
    (e) => ({ status: e?.status, code: e?.code, param: e?.param }),
  );
}

describe("RB6 global max output tokens", () => {
  it("PoC: max_tokens 9,999,999 on a model without metadata → 400, nothing sent upstream", async () => {
    const f = upstream();
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const r = await errorOf(gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 9_999_999 }));
    expect(r).toEqual({ status: 400, code: "max_tokens_exceeded", param: "max_tokens" });
    expect(f.calls).toHaveLength(0);
  });

  it("the default is 65536; max_completion_tokens is checked and named too", async () => {
    upstream();
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(65536);
    expect(await errorOf(gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 65536 }))).toBe(
      "ok",
    );
    const r = await errorOf(
      gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxCompletionTokens: 65537 }),
    );
    expect(r).toEqual({ status: 400, code: "max_tokens_exceeded", param: "max_completion_tokens" });
  });

  it("limits.maxOutputTokens is configurable; legacy completions are checked as well", async () => {
    upstream();
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [target("a")],
      limits: { maxOutputTokens: 1000 },
    });
    expect(await errorOf(gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 1000 }))).toBe(
      "ok",
    );
    expect(await errorOf(gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 1001 }))).toEqual({
      status: 400,
      code: "max_tokens_exceeded",
      param: "max_tokens",
    });
    const r = await errorOf(
      gw.execute(completionsSurface, { model: "m", messages: msg, maxTokens: 5000 }, { metadata: {} } as never),
    );
    expect(r).toEqual({ status: 400, code: "max_tokens_exceeded", param: "max_tokens" });
  });

  it("a model's published maxOutputTokens wins over the global limit", async () => {
    upstream();
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [target("a", ["big", "small"])],
      limits: { maxOutputTokens: 1000 },
      models: [
        { name: "big", bindings: [{ target: "a" }], metadata: { maxOutputTokens: 200_000 } },
        { name: "small", bindings: [{ target: "a" }], metadata: { maxOutputTokens: 100 } },
      ],
    });
    expect(
      await errorOf(gw.route({ metadata: {} } as never, { model: "big", messages: msg, maxTokens: 150_000 })),
    ).toBe("ok");
    expect(
      await errorOf(gw.route({ metadata: {} } as never, { model: "small", messages: msg, maxTokens: 101 })),
    ).toEqual({ status: 400, code: "max_tokens_exceeded", param: "max_tokens" });
  });

  it("a request without max_tokens is not rejected", async () => {
    upstream();
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    expect(await errorOf(gw.route({ metadata: {} } as never, { model: "m", messages: msg }))).toBe("ok");
  });
});
