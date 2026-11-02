/**
 * C4 (review 2026-11-02, redteam RB2): streams never asked the upstream for
 * usage (stream_options.include_usage was only forwarded when the client sent
 * it), so a client that omits it — the OpenAI SDK default — was metered by a
 * ~4 chars/token estimate: Chinese output undercounted 2.5–6x (real 620
 * tokens counted 101). Fixed: the provider always asks for usage where the
 * provider supports stream_options; the usage-only chunk is kept off a
 * client stream that did not ask for it; the fallback estimate (upstream
 * sends no usage at all) is CJK-aware and shared with the model policy.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { estimatePromptTokens as policyEstimate } from "@/core/model-policy";
import { estimatePromptTokens, estimateTextTokens } from "@/core/usage";
import type { StreamChunk } from "@/providers/types";
import { chunk, fakeFetch, makeGateway, meteredClient, sse, target } from "./_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const REAL = { prompt_tokens: 20, completion_tokens: 600, total_tokens: 620 };

/** Upstream that behaves like OpenAI / DeepSeek: a usage chunk only when asked. */
function openAiLikeUpstream() {
  return fakeFetch((_u, _i, body) => {
    const events: unknown[] = [chunk("你好世界".repeat(100)), chunk("", "stop")];
    if (body?.stream_options?.include_usage === true) events.push({ ...chunk(""), choices: [], usage: REAL });
    return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
  });
}

async function drain(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("C4 stream usage comes from the upstream", () => {
  it("meters the upstream's real usage even if the client did not ask for it", async () => {
    const f = openAiLikeUpstream();
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("k1") };
    const out = await drain(
      gw.routeStream(ctx as never, { model: "m", messages: [{ role: "user", content: "写一首诗" }], stream: true }),
    );
    await Bun.sleep(5);
    expect(gw.keyMeter().used("k1")).toBe(620);
    expect(f.calls[0]?.body?.stream_options).toEqual({ include_usage: true });
    // The client did not ask: the usage-only chunk is not forwarded.
    expect(out.some((c) => c.usage !== undefined)).toBe(false);
    expect(out.every((c) => c.choices.length > 0)).toBe(true);
  });

  it("forwards the usage chunk when the client asked for it", async () => {
    const f = openAiLikeUpstream();
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("k1") };
    const out = await drain(
      gw.routeStream(ctx as never, {
        model: "m",
        messages: [{ role: "user", content: "写一首诗" }],
        stream: true,
        streamOptions: { includeUsage: true },
      }),
    );
    await Bun.sleep(5);
    expect(gw.keyMeter().used("k1")).toBe(620);
    const last = out.at(-1);
    expect(last?.choices.length).toBe(0);
    expect(last?.usage?.totalTokens).toBe(620);
  });

  it("does not send stream_options to a provider without it; the fallback estimate is CJK-aware", async () => {
    const f = openAiLikeUpstream();
    restore = f.restore;
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [target("a", ["m"], { provider: "mistral" })],
    });
    const ctx = { metadata: {}, client: meteredClient("k1") };
    await drain(
      gw.routeStream(ctx as never, { model: "m", messages: [{ role: "user", content: "写一首诗" }], stream: true }),
    );
    await Bun.sleep(5);
    expect(f.calls[0]?.body?.stream_options).toBeUndefined();
    // 400 Chinese characters of output count at least 400 tokens (was 100).
    expect(gw.keyMeter().used("k1")).toBeGreaterThanOrEqual(400 + 4);
  });
});

describe("C4 shared token estimator", () => {
  it("counts CJK characters one token each and other text by UTF-8 bytes / 4", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("你好世界")).toBe(4);
    expect(estimateTextTokens("こんにちは")).toBe(5);
    expect(estimateTextTokens("안녕하세요")).toBe(5);
    expect(estimateTextTokens("x".repeat(400))).toBe(100);
    expect(estimateTextTokens("𠀀")).toBe(1); // CJK extension B (astral)
    expect(estimateTextTokens("中文 mixed text")).toBe(2 + Math.ceil(" mixed text".length / 4));
  });

  it("the model policy uses the same estimator", () => {
    const req = {
      messages: [
        { role: "system" as const, content: "你是助手" },
        { role: "user" as const, content: "hello 世界" },
      ],
    };
    expect(policyEstimate(req)).toBe(estimatePromptTokens(req));
    expect(estimatePromptTokens(req)).toBe(4 + 4 + 4 + 2 + Math.ceil("hello ".length / 4));
  });
});
