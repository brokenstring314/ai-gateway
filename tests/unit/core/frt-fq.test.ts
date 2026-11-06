/**
 * Final red team 2026-11-06 FQ-1 … FQ-3, unit level: the non-text part
 * estimate, reasoning budget fields, the n cap, the moderation-403
 * classifier and its sanitized message. End-to-end repros:
 * tests/integration/frt-fq-quota.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type GatewayError, toGatewayError } from "@/core/errors";
import { checkLimits, reasoningBudgetOf, requestedOutputCapOf } from "@/core/model-policy";
import {
  classifyAttemptError,
  contentFilteredMessage,
  isBreakerFailure,
  isContentFilteredError,
  isFailoverEligible,
} from "@/core/outcome";
import { MAX_N, nProblem } from "@/core/request-limits";
import { estimateNonTextPartTokens, estimatePromptTokens, NON_TEXT_PART_TOKENS } from "@/core/usage";
import { ProviderError } from "@/providers/openai-compat";
import { KeyMeter } from "@/usage/key-meter";
import { chatJson, fakeFetch, makeGateway, target } from "../../regressions/core/_review";

const T = NON_TEXT_PART_TOKENS;

describe("FQ-1: non-text parts are estimated conservatively", () => {
  it("images, audio, files, video and unknown parts", () => {
    expect(estimateNonTextPartTokens({ type: "image_url", imageUrl: { url: "https://x/y.png", detail: "low" } })).toBe(
      T.image,
    );
    // 1 MB of base64 audio ≈ 750 KB decoded.
    const audio = "A".repeat(1_000_000);
    expect(
      estimateNonTextPartTokens({ type: "input_audio", raw: { type: "input_audio", input_audio: { data: audio } } }),
    ).toBe(Math.ceil(750_000 / T.audioBytesPerToken));
    expect(
      estimateNonTextPartTokens({ type: "input_audio", raw: { type: "input_audio", input_audio: { data: "AAAA" } } }),
    ).toBe(T.audioMin);
    const pdf = `data:application/pdf;base64,${"A".repeat(400_000)}`;
    expect(estimateNonTextPartTokens({ type: "file", raw: { type: "file", file: { file_data: pdf } } })).toBe(
      Math.ceil(300_000 / T.fileBytesPerToken),
    );
    expect(estimateNonTextPartTokens({ type: "file", raw: { type: "file", file: { file_id: "file-1" } } })).toBe(
      T.fileRef,
    );
    expect(estimateNonTextPartTokens({ type: "video_url", raw: { type: "video_url", video_url: { url: "u" } } })).toBe(
      T.video,
    );
    expect(estimateNonTextPartTokens({ type: "refusal", raw: { type: "refusal", refusal: "x".repeat(400) } })).toBe(
      Math.ceil(JSON.stringify({ type: "refusal", refusal: "x".repeat(400) }).length / 4),
    );
  });

  it("the prompt estimate counts parts, message extras, a json_schema and a prediction", () => {
    const base = estimatePromptTokens({ messages: [{ role: "user", content: "hi" }] });
    expect(base).toBe(5);
    const withImages = estimatePromptTokens({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", imageUrl: { url: "https://x/1.png" } },
            { type: "image_url", imageUrl: { url: "https://x/2.png" } },
          ],
        },
      ],
    });
    expect(withImages).toBe(5 + 2 * T.image);
    const extras = estimatePromptTokens({
      messages: [{ role: "assistant", content: "", extra: { reasoning_content: "r".repeat(400) } }],
      responseFormat: { type: "json_schema", jsonSchema: { name: "s", schema: { d: "d".repeat(400) } } },
      extra: { prediction: { type: "content", content: "p".repeat(400) } },
    });
    expect(extras).toBeGreaterThan(4 + 300);
  });
});

describe("FQ-1: reasoning budget fields", () => {
  it("the largest budget wins, numeric strings count, junk is ignored", () => {
    expect(reasoningBudgetOf({ reasoning: { max_tokens: 100 }, thinking: { budget_tokens: "300" } })).toEqual({
      value: 300,
      param: "thinking.budget_tokens",
    });
    expect(reasoningBudgetOf({ chat_template_kwargs: { thinking_budget: 7 } })?.param).toBe(
      "chat_template_kwargs.thinking_budget",
    );
    expect(reasoningBudgetOf({ reasoning: { max_tokens: -1 }, thinking: "x" })).toBeUndefined();
    expect(requestedOutputCapOf({ maxTokens: 1, extra: { reasoning: { max_tokens: 32_000 } } })).toEqual({
      value: 32_000,
      param: "reasoning.max_tokens",
    });
    expect(requestedOutputCapOf({ maxTokens: 50_000, extra: { reasoning: { max_tokens: 32_000 } } })?.param).toBe(
      "max_tokens",
    );
  });

  it("checkLimits refuses a budget over the limit, naming it", () => {
    let err: GatewayError | undefined;
    try {
      checkLimits(
        { model: "m", messages: [], maxTokens: 1, extra: { thinking: { budget_tokens: 70_000 } } },
        undefined,
        "m",
        65_536,
      );
    } catch (e) {
      err = e as GatewayError;
    }
    expect(err?.code).toBe("max_tokens_exceeded");
    expect(err?.param).toBe("thinking.budget_tokens");
  });

  it("a reasoning_effort the model maps to a budget is reserved", async () => {
    const f = fakeFetch(() => chatJson("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    try {
      const { gw } = makeGateway({
        strategy: { mode: "single" },
        targets: [target("a")],
        models: [
          {
            name: "m",
            bindings: [{ target: "a" }],
            metadata: {
              reasoning: { efforts: ["low", "high"], map: { high: { thinking: { budget_tokens: 30_000 } } } },
            },
          },
        ],
      });
      const client = { id: "fq-map", limits: { quotaTokens: 20_000, rpm: null, tpm: null } };
      const ask = (effort: string) =>
        gw
          .route({ metadata: {}, client } as never, {
            model: "m",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 10,
            extra: { reasoning_effort: effort },
          })
          .then(
            () => "200",
            (e) => `${e.status} ${e.code} ${e.param}`,
          );
      expect(await ask("high")).toBe("400 request_exceeds_quota thinking.budget_tokens");
      expect(await ask("low")).toBe("200");
      expect(f.calls).toHaveLength(1);
    } finally {
      f.restore();
    }
  });
});

describe("FQ-2: n cap and the per-request admission rules", () => {
  it("n above MAX_N is a 400 invalid_n", () => {
    expect(nProblem(MAX_N)).toBeUndefined();
    expect(nProblem(undefined)).toBeUndefined();
    const e = nProblem(MAX_N + 1)!;
    expect(e.status).toBe(400);
    expect(e.code).toBe("invalid_n");
    expect(e.param).toBe("n");
  });

  it("the key meter refuses a reservation above the quota left (400) or the TPM (400), never clamping it", () => {
    const m = new KeyMeter();
    const q = { id: "q", limits: { quotaTokens: 1000, rpm: null, tpm: null } };
    let room: unknown;
    const tooBig = (() => {
      try {
        m.admit(q, {
          reserve: (r) => {
            room = r;
            return { tokens: 1500, param: "max_tokens", describe: "about 5 input tokens + max_tokens 1495" };
          },
        });
      } catch (e) {
        return e as GatewayError;
      }
    })();
    expect(room).toEqual({ quotaLeft: 1000 });
    expect(tooBig?.status).toBe(400);
    expect(tooBig?.code).toBe("request_exceeds_quota");
    expect(tooBig?.message).toContain("1000 of 1000");
    expect(m.reserved("q")).toBe(0);
    m.admit(q, { reserve: () => 1000 }); // exactly the quota: admitted

    const t = { id: "t", limits: { quotaTokens: null, rpm: null, tpm: 500 } };
    const tpm = (() => {
      try {
        m.admit(t, { reserve: () => 501 });
      } catch (e) {
        return e as GatewayError;
      }
    })();
    expect(tpm?.status).toBe(400);
    expect(tpm?.code).toBe("request_exceeds_tpm");
  });
});

describe("FQ-2: max_tokens goes to official OpenAI as max_completion_tokens", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("only when the gateway set it, and only for api.openai.com", async () => {
    const original = globalThis.fetch;
    const bodies: Array<{ host: string; body: any }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      bodies.push({ host: url.hostname, body: JSON.parse(String(init?.body ?? "{}")) });
      return chatJson("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    }) as typeof fetch;
    restore = () => (globalThis.fetch = original);
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [
        {
          name: "oa",
          provider: "openai",
          apiKey: "sk-test-0123456789",
          baseURL: "https://api.openai.com/v1",
          models: ["o"],
        },
        target("a", ["m"]),
      ],
      models: [
        { name: "o", bindings: [{ target: "oa" }], metadata: { maxOutputTokens: 1000 } },
        { name: "m", bindings: [{ target: "a" }], metadata: { maxOutputTokens: 1000 } },
      ],
    });
    const msg = [{ role: "user" as const, content: "hi" }];
    await gw.route({ metadata: {} } as never, { model: "o", messages: msg });
    await gw.route({ metadata: {} } as never, { model: "o", messages: msg, maxTokens: 7 });
    await gw.route({ metadata: {} } as never, { model: "m", messages: msg });
    expect(bodies[0]!.body.max_completion_tokens).toBe(1000);
    expect(bodies[0]!.body.max_tokens).toBeUndefined();
    expect(bodies[1]!.body.max_tokens).toBe(7); // the client's own field, untouched
    expect(bodies[1]!.body.max_completion_tokens).toBeUndefined();
    expect(bodies[2]!.body.max_tokens).toBe(1000);
  });
});

describe("FQ-3: content-moderation 403 classification", () => {
  const up = (status: number, body: Record<string, unknown>) =>
    new ProviderError("t", status, String(body["message"] ?? ""), { origin: "upstream", upstream: body });

  it("moderation markers → caller error: no breaker failure, no failover, 400 content_filtered", () => {
    const cases = [
      up(403, { message: "Your chosen model requires moderation and your input was flagged" }),
      up(403, { message: "blocked", metadata: { reasons: ["hate"] } }),
      up(403, { message: "Content Exists Risk" }),
      up(403, { message: "Your request was rejected as a result of our safety system." }),
      up(403, { message: "Input data may contain inappropriate content.", code: "DataInspectionFailed" }),
      up(403, { message: "输入内容包含敏感信息" }),
      up(451, { message: "content policy violation" }),
    ];
    for (const e of cases) {
      expect(isContentFilteredError(e)).toBe(true);
      expect(isBreakerFailure(e)).toBe(false);
      expect(isFailoverEligible(e)).toBe(false);
      expect(classifyAttemptError(e, { admitted: true }).breaker).toBe("release");
      const g = toGatewayError(e);
      expect(g.status).toBe(400);
      expect(g.code).toBe("content_filtered");
      expect(g.kind).toBe("upstream_client");
    }
  });

  it("credential / account / region 403s and other statuses stay target failures", () => {
    const cases = [
      up(403, { message: "Invalid API key", code: "invalid_api_key" }),
      up(403, { message: "Your account was flagged for policy violations" }),
      up(403, { message: "Country, region, or territory not supported", code: "unsupported_country_region_territory" }),
      up(403, { message: "permission denied" }),
      up(400, { message: "your input was flagged" }), // a 400 is already the caller's, passed through as is
    ];
    for (const e of cases) expect(isContentFilteredError(e)).toBe(false);
    expect(isBreakerFailure(cases[0])).toBe(true);
    expect(toGatewayError(cases[0]).code).toBe("upstream_auth_failed");
    // A transport error is never a moderation refusal.
    expect(isContentFilteredError(new ProviderError("t", 403, "flagged", { origin: "local" }))).toBe(false);
  });

  it("the client message is sanitized: no control characters, URLs or token-like strings, bounded, reasons appended", () => {
    const e = up(403, {
      message: `flagged\u0000\u001b[31m see https://example.com/policy?id=1 key sk-abcdefghijklmnop0123456789 ${"z".repeat(1000)}`,
      metadata: { reasons: ["violence", "<script>"], flagged_input: "SECRET USER TEXT" },
    });
    const msg = contentFilteredMessage(e);
    expect([...msg].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
    expect(msg).not.toContain("https://");
    expect(msg).not.toContain("sk-abcdefghijklmnop0123456789");
    expect(msg).not.toContain("SECRET USER TEXT");
    expect(msg).toContain("Reasons: violence, script.");
    expect(msg.length).toBeLessThan(450);
  });

  it("a flagged stream request: 400 content_filtered and the breaker stays closed", async () => {
    const f = fakeFetch(() =>
      Response.json({ error: { message: "Your input was flagged", code: 403 } }, { status: 403 }),
    );
    try {
      const { gw } = makeGateway({
        strategy: { mode: "single" },
        targets: [target("a", ["m"], { circuitBreaker: { failureThreshold: 1, timeoutMs: 60_000 } })],
      });
      for (let i = 0; i < 3; i++) {
        const it = gw.routeStream({ metadata: {} } as never, {
          model: "m",
          messages: [{ role: "user", content: "x" }],
          stream: true,
        });
        const code = await it.next().then(
          () => "ok",
          (e) => toGatewayError(e).code,
        );
        expect(code).toBe("content_filtered");
      }
      expect(f.calls).toHaveLength(3); // never short-circuited by an open breaker
    } finally {
      f.restore();
    }
  });
});
