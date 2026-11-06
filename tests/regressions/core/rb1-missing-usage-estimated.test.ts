/**
 * RB1 / C3 (red team + core review 2026-11-02) — fixed: a non-streaming
 * response without `usage` was counted as 0 tokens, so a key with a token
 * quota never ran out. Red-team PoC: quota 1000, 30 requests (max_tokens
 * 1000) to an upstream that omits usage → 30 × HTTP 200, gateway counted 0.
 * Now a missing or implausible usage (missing, all zero with output,
 * negative / NaN, zero completion with output) is metered with the shared
 * estimator (prompt incl. tools/system + returned content / tool calls /
 * reasoning) and the request log says usageEstimated.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { resolveUsage } from "@/core/usage";
import { chatJson, fakeFetch, makeGateway, meteredClient, target } from "./_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const msg = [{ role: "user" as const, content: "x" }];

async function status(p: Promise<unknown>): Promise<number> {
  return p.then(
    () => 200,
    (e) => e?.status ?? e?.statusCode ?? 0,
  );
}

describe("RB1 non-stream response without usage", () => {
  it("PoC numbers: quota 1000, 30 requests, upstream omits usage → quota enforced", async () => {
    // ~1000 output tokens per answer (4000 ASCII chars), and no usage field.
    const f = fakeFetch(() => chatJson("y".repeat(4000)));
    restore = f.restore;
    const { gw, logs } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("rb1", 1000) };
    const codes: number[] = [];
    // max_tokens 990: prompt + max_tokens must fit the quota left (FQ-2).
    for (let i = 0; i < 30; i++)
      codes.push(await status(gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 990 })));
    // Before the fix: 30 × 200 and used 0. Now the first request is counted
    // (≈ 5 prompt + 1000 completion) and every later one is refused.
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 403)).toHaveLength(29);
    expect(gw.keyMeter().used("rb1")).toBe(4 + 1 + 1000);
    expect(logs.find((l) => l.status === 200)?.usageEstimated).toBe(true);
  });

  it("counts a short answer by its estimate instead of 0", async () => {
    const f = fakeFetch(() => chatJson("ok"));
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("rb1b", 1000) };
    for (let i = 0; i < 30; i++) await gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 10 });
    expect(gw.keyMeter().used("rb1b")).toBe(30 * (5 + 1));
  });

  it("an all-zero usage with output is estimated; a plausible usage is trusted", async () => {
    let usage: Record<string, number> = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const f = fakeFetch(() => chatJson("y".repeat(400), usage));
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("rb1c") };
    await gw.route(ctx as never, { model: "m", messages: msg });
    expect(gw.keyMeter().used("rb1c")).toBe(5 + 100);
    usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
    await gw.route(ctx as never, { model: "m", messages: msg });
    expect(gw.keyMeter().used("rb1c")).toBe(105 + 10);
  });

  it("embeddings without usage are estimated from the input", async () => {
    const f = fakeFetch(() => Response.json({ object: "list", model: "m", data: [{ embedding: [0.1], index: 0 }] }));
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("rb1e") };
    await gw.embedWithPlugins(ctx as never, { model: "m", input: ["a".repeat(40), "你好"] });
    expect(gw.keyMeter().used("rb1e")).toBe(10 + 2);
  });
});

describe("RB1 resolveUsage", () => {
  const est = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
  const estimate = () => est;
  it("missing, NaN or negative → estimate", () => {
    expect(resolveUsage(undefined, estimate)).toEqual({ usage: est, estimated: true });
    expect(resolveUsage({ promptTokens: Number.NaN, completionTokens: 1, totalTokens: 1 }, estimate).estimated).toBe(
      true,
    );
    expect(resolveUsage({ promptTokens: -1000, completionTokens: 5, totalTokens: -995 }, estimate).estimated).toBe(
      true,
    );
  });
  it("zero completion with output → completion estimated, prompt kept", () => {
    expect(resolveUsage({ promptTokens: 50, completionTokens: 0, totalTokens: 50 }, estimate)).toEqual({
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      estimated: true,
    });
  });
  it("zero completion without output, or a normal usage → trusted", () => {
    const none = () => ({ promptTokens: 10, completionTokens: 0, totalTokens: 10 });
    const u = { promptTokens: 50, completionTokens: 0, totalTokens: 50 };
    expect(resolveUsage(u, none)).toEqual({ usage: u, estimated: false });
    const ok = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    expect(resolveUsage(ok, estimate)).toEqual({ usage: ok, estimated: false });
  });
});
