/**
 * Final red team 2026-11-06 (quota / rate-limit abuse), FQ-1 … FQ-3, through
 * the real Hono app against a fake upstream that BILLS like a real one (the
 * red team's repros/quota/mock.ts): prompt = text chars / 4 + 1000 per image
 * + 2000 per file / audio part; completion = (max_tokens ?? 32768) × n +
 * the reasoning budget. The assertions compare what the upstream billed with
 * the key's quota / TPM.
 *
 *  - FQ-1: image / file / audio parts and reasoning budget fields reserved 0
 *    → a quota-1000 key got ~143 concurrent admits, 2,860–4,000× overspend.
 *  - FQ-2: one request was never compared with the quota left / the TPM; n
 *    was forwarded unbounded; without max_tokens the upstream used its own
 *    default (a quota-1000 key billed 32,768,001 in one request).
 *  - FQ-3: a content-moderation 403 counted as a breaker failure (3 flagged
 *    prompts opened the channel for every tenant) and read as
 *    upstream_auth_failed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { adminHarness, type Harness, logicalUrl, yamlTarget } from "./_admin-harness.js";

const HOST = "bill.upstream.test";
const UPSTREAM_DEFAULT_MAX = 32_768;

/** The billing upstream: one per test file, reset after each test. */
const bill = {
  calls: [] as any[],
  billed: 0,
  inflight: 0,
  maxInflight: 0,
  delayMs: 0,
  omitUsage: false,
  reset() {
    this.calls.length = 0;
    this.billed = 0;
    this.inflight = 0;
    this.maxInflight = 0;
    this.delayMs = 0;
    this.omitUsage = false;
  },
};

function promptBill(messages: any[]): number {
  let chars = 0;
  let extra = 0;
  for (const m of messages ?? []) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") chars += (p.text ?? "").length;
        else if (p.type === "image_url") extra += 1000;
        else if (p.type === "file" || p.type === "input_audio") extra += 2000;
      }
    }
  }
  return Math.ceil(chars / 4) + extra;
}

async function answer(body: any): Promise<Response> {
  bill.calls.push(body);
  if (JSON.stringify(body.messages ?? "").includes("FLAGME")) {
    return Response.json(
      {
        error: {
          message: "Your chosen model requires moderation and your input was flagged",
          code: 403,
          metadata: { reasons: ["violence"], flagged_input: "FLAGME…", provider_name: "x" },
        },
      },
      { status: 403 },
    );
  }
  if (JSON.stringify(body.messages ?? "").includes("BADKEY")) {
    return Response.json({ error: { message: "Invalid API key provided", code: "invalid_api_key" } }, { status: 403 });
  }
  const n = Number(body.n ?? 1);
  const cap = Number(body.max_tokens ?? body.max_completion_tokens ?? UPSTREAM_DEFAULT_MAX);
  const think = Number(body.thinking?.budget_tokens ?? body.reasoning?.max_tokens ?? 0);
  const prompt = promptBill(body.messages);
  const completion = cap * n + think;
  bill.billed += prompt + completion;
  bill.inflight++;
  bill.maxInflight = Math.max(bill.maxInflight, bill.inflight);
  try {
    if (bill.delayMs > 0) await Bun.sleep(bill.delayMs);
  } finally {
    bill.inflight--;
  }
  const usage = bill.omitUsage
    ? undefined
    : { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  return Response.json({
    id: "c1",
    object: "chat.completion",
    created: 1,
    model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "length" }],
    ...(usage ? { usage } : {}),
  });
}

let original: typeof fetch;
beforeAll(() => {
  original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const { url } = logicalUrl(input, init);
    if (url.hostname !== HOST) return original(input as never, init);
    const text = typeof init?.body === "string" ? init.body : "";
    return answer(text ? JSON.parse(text) : {});
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = original;
});
afterEach(() => bill.reset());

function file(extra: Record<string, unknown> = {}, target: Record<string, unknown> = {}) {
  return {
    strategy: { mode: "single", targets: ["bill"] },
    targets: [
      {
        ...yamlTarget("bill", ["m", "big"]),
        baseURL: `https://${HOST}/v1`,
        circuitBreaker: { failureThreshold: 3, timeoutMs: 60_000 },
        ...target,
      },
    ],
    ...extra,
  };
}

const ids = new Map<string, string>();

async function key(h: Harness, body: Record<string, unknown>): Promise<string> {
  const r = await h.admin("POST", "/keys", { name: "guest", ...body });
  expect(r.status).toBe(201);
  const created = (await r.json()) as { key: string; id: string };
  ids.set(created.key, created.id);
  return created.key;
}

async function used(h: Harness, k: string): Promise<number> {
  const r = await h.admin("GET", `/keys/${ids.get(k)}`);
  return ((await r.json()) as any).usedTokens;
}

function post(h: Harness, k: string, body: Record<string, unknown>, path = "/v1/chat/completions") {
  return h.app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${k}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "m", ...body }),
  });
}

async function burst(h: Harness, k: string, n: number, body: Record<string, unknown>) {
  const res = await Promise.all(Array.from({ length: n }, () => post(h, k, body)));
  const hist: Record<string, number> = {};
  for (const r of res) {
    const code = r.status === 200 ? "200" : `${r.status}:${((await r.json()) as any).error?.code}`;
    hist[code] = (hist[code] ?? 0) + 1;
  }
  return hist;
}

const images20 = [
  {
    role: "user",
    content: [
      { type: "text", text: "describe" },
      ...Array.from({ length: 20 }, (_, i) => ({ type: "image_url", image_url: { url: `https://img.test/${i}.png` } })),
    ],
  },
];

describe("FQ-1: non-text parts and reasoning budgets are reserved", () => {
  it("repro t1: 200 concurrent 20-image requests on a quota-1000 key → refused, upstream bills nothing (was 2,860,429)", async () => {
    const h = await adminHarness(file());
    const k = await key(h, { quotaTokens: 1000 });
    bill.delayMs = 50;
    const hist = await burst(h, k, 200, { max_tokens: 1, messages: images20 });
    // 20 × 1,600 ≈ 32,000 reserved per request: more than the whole quota.
    expect(hist).toEqual({ "400:request_exceeds_quota": 200 });
    expect(bill.calls).toHaveLength(0);
    expect(bill.billed).toBe(0);
  });

  it("with room for a few, concurrent admits are bounded by the conservative reservation and billing stays within the quota", async () => {
    const h = await adminHarness(file());
    const k = await key(h, { quotaTokens: 100_000 });
    bill.delayMs = 50;
    const hist = await burst(h, k, 100, { max_tokens: 1, messages: images20 });
    // ≈ 32,0xx reserved each: 3 fit 100,000.
    expect(hist["200"]).toBe(3);
    expect(hist["429:quota_in_flight"]).toBe(97);
    expect(bill.billed).toBeLessThanOrEqual(100_000);
  });

  it("repro t6: max_tokens 1 + reasoning.max_tokens 32000 on a quota-1000 key → 400 naming the budget (was 4,000,500 billed)", async () => {
    const h = await adminHarness(file());
    const k = await key(h, { quotaTokens: 1000 });
    const r = await post(h, k, {
      max_tokens: 1,
      reasoning: { max_tokens: 32_000 },
      messages: [{ role: "user", content: "think" }],
    });
    expect(r.status).toBe(400);
    const err = ((await r.json()) as any).error;
    expect(err.code).toBe("request_exceeds_quota");
    expect(err.param).toBe("reasoning.max_tokens");
    expect(err.message).toContain("1000");
    const hist = await burst(h, k, 150, {
      max_tokens: 1,
      thinking: { type: "enabled", budget_tokens: 32_000 },
      messages: [{ role: "user", content: "think" }],
    });
    expect(hist).toEqual({ "400:request_exceeds_quota": 150 });
    expect(bill.billed).toBe(0);
  });

  it("a reasoning budget over the output limit is a 400 max_tokens_exceeded naming it (never clamped)", async () => {
    const h = await adminHarness(file({ limits: { maxOutputTokens: 1000 } }));
    const k = await key(h, {});
    const r = await post(h, k, {
      max_tokens: 10,
      thinking: { type: "enabled", budget_tokens: 5000 },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.status).toBe(400);
    const err = ((await r.json()) as any).error;
    expect(err.code).toBe("max_tokens_exceeded");
    expect(err.param).toBe("thinking.budget_tokens");
    expect(bill.calls).toHaveLength(0);
    // Within the limit: forwarded unchanged.
    const ok = await post(h, k, {
      max_tokens: 10,
      reasoning: { max_tokens: 900 },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ok.status).toBe(200);
    expect(bill.calls[0].max_tokens).toBe(10);
    expect(bill.calls[0].reasoning).toEqual({ max_tokens: 900 });
  });

  it("repro t3: no usage from the upstream → images are charged by the estimate (was 77 for 220,033 billed)", async () => {
    const h = await adminHarness(file());
    const k = await key(h, { quotaTokens: 10_000_000 });
    bill.omitUsage = true;
    for (let i = 0; i < 3; i++) expect((await post(h, k, { max_tokens: 1, messages: images20 })).status).toBe(200);
    const charged = await used(h, k);
    // ≥ 20 × 1,600 per request (the upstream billed 20 × 1,000 + text).
    expect(charged).toBeGreaterThanOrEqual(3 * 20 * 1600);
  });
});

describe("FQ-2: one request is held to the quota left and the TPM; n is capped; max_tokens is explicit", () => {
  it("repro t2: n = 1000 → 400 invalid_n before anything is sent", async () => {
    const h = await adminHarness(file());
    const k = await key(h, { quotaTokens: 1000 });
    const r = await post(h, k, { n: 1000, messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(400);
    const err = ((await r.json()) as any).error;
    expect(err.code).toBe("invalid_n");
    expect(err.param).toBe("n");
    expect(bill.calls).toHaveLength(0);
    // Unlimited key: n = 128 is allowed, 129 is not.
    const free = await key(h, {});
    expect((await post(h, free, { n: 128, max_tokens: 1, messages: [{ role: "user", content: "hi" }] })).status).toBe(
      200,
    );
    expect((await post(h, free, { n: 129, max_tokens: 1, messages: [{ role: "user", content: "hi" }] })).status).toBe(
      400,
    );
  });

  it("quota-1000 key without max_tokens: the default is fitted into what is left and sent upstream (was 32,768,001 billed)", async () => {
    const h = await adminHarness(file());
    const k = await key(h, { quotaTokens: 1000 });
    const r = await post(h, k, { n: 4, messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(200);
    // (1000 − ≈5 prompt) / 4 choices.
    expect(bill.calls[0].max_tokens).toBe(248);
    expect(bill.calls[0].n).toBe(4);
    expect(bill.billed).toBeLessThanOrEqual(1000);
  });

  it("a client max_tokens larger than the quota left → 400 request_exceeds_quota, never lowered", async () => {
    const h = await adminHarness(file());
    const k = await key(h, { quotaTokens: 1000 });
    const r = await post(h, k, { max_tokens: 2000, messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(400);
    const err = ((await r.json()) as any).error;
    expect(err.code).toBe("request_exceeds_quota");
    expect(err.param).toBe("max_tokens");
    expect(err.message).toContain("1000 of 1000");
    expect(bill.calls).toHaveLength(0);
    // Fits: forwarded exactly as sent.
    expect((await post(h, k, { max_tokens: 500, messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    expect(bill.calls[0].max_tokens).toBe(500);
    // 501 used, 499 left: 5 + 495 does not fit, 5 + 494 does.
    const over = await post(h, k, { max_tokens: 495, messages: [{ role: "user", content: "hi" }] });
    expect(over.status).toBe(400);
    expect(((await over.json()) as any).error.message).toContain("499 of 1000");
    expect((await post(h, k, { max_tokens: 494, messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    expect(bill.billed).toBeLessThanOrEqual(1000);
  });

  it("repro t2 (TPM): a request larger than the whole TPM → 400 request_exceeds_tpm; without max_tokens it is fitted (was 32,768× the TPM)", async () => {
    const h = await adminHarness(file());
    const k = await key(h, { tpm: 1000 });
    const r = await post(h, k, { max_tokens: 5000, messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe("request_exceeds_tpm");
    const big = await post(h, k, { n: 1000, messages: [{ role: "user", content: "hi" }] });
    expect(big.status).toBe(400);
    expect(bill.calls).toHaveLength(0);
    // Without max_tokens: max_tokens = TPM − prompt. The window then holds
    // 996 < 1000, so one more is admitted (a window holds at most ≈ 2 × TPM),
    // and the next waits for the window.
    expect((await post(h, k, { messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    expect(bill.calls[0].max_tokens).toBe(995);
    expect((await post(h, k, { messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    const next = await post(h, k, { messages: [{ role: "user", content: "hi" }] });
    expect(next.status).toBe(429);
    expect(((await next.json()) as any).error.code).toBe("rate_limit_exceeded");
    expect(bill.billed).toBeLessThanOrEqual(2 * 1000);
  });

  it("an unlimited key gets the model's published maxOutputTokens as max_tokens; no metadata → nothing added", async () => {
    const h = await adminHarness(
      file({
        models: [
          { name: "m", bindings: [{ target: "bill" }], metadata: { maxOutputTokens: 4096 } },
          { name: "big", bindings: [{ target: "bill" }] },
        ],
      }),
    );
    const k = await key(h, {});
    expect((await post(h, k, { messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    expect(bill.calls[0].max_tokens).toBe(4096);
    expect((await post(h, k, { model: "big", messages: [{ role: "user", content: "hi" }] })).status).toBe(200);
    expect(bill.calls[1].max_tokens).toBeUndefined();
    expect(bill.calls[1].max_completion_tokens).toBeUndefined();
  });

  it("the explicit max_tokens never exceeds the context window left after the prompt", async () => {
    const h = await adminHarness(
      file({
        models: [
          { name: "m", bindings: [{ target: "bill" }], metadata: { maxOutputTokens: 4096, contextWindow: 4200 } },
        ],
      }),
    );
    const k = await key(h, {});
    expect((await post(h, k, { messages: [{ role: "user", content: "x".repeat(800) }] })).status).toBe(200);
    // 4200 − (4 + 200) prompt tokens.
    expect(bill.calls[0].max_tokens).toBe(3996);
  });
});

describe("FQ-3: a content-moderation 403 is the caller's error", () => {
  it("repro t4: three flagged prompts no longer open the breaker; the client gets 400 content_filtered", async () => {
    const h = await adminHarness(file());
    const atk = await key(h, { quotaTokens: 100_000 });
    const victim = await key(h, {});
    expect((await post(h, victim, { max_tokens: 3, messages: [{ role: "user", content: "hello" }] })).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      const r = await post(h, atk, { max_tokens: 3, messages: [{ role: "user", content: `FLAGME ${i}` }] });
      expect(r.status).toBe(400);
      const err = ((await r.json()) as any).error;
      expect(err.code).toBe("content_filtered");
      expect(err.message).toContain("your input was flagged");
      expect(err.message).toContain("violence");
      expect(err.message).not.toContain("FLAGME");
    }
    // The channel stays closed for everyone.
    const after = await post(h, victim, { max_tokens: 3, messages: [{ role: "user", content: "hello again" }] });
    expect(after.status).toBe(200);
    const status = (await (await h.admin("GET", "/status")).json()) as any;
    expect(String(status.circuitBreakers?.bill ?? "closed").toLowerCase()).toBe("closed");
  });

  it("no failover to the next channel for a flagged prompt, and the channel key is not disabled", async () => {
    const h = await adminHarness({
      strategy: { mode: "fallback", targets: ["bill", "bill2"] },
      targets: [
        { ...yamlTarget("bill", ["m"]), baseURL: `https://${HOST}/v1` },
        { ...yamlTarget("bill2", ["m"]), baseURL: `https://${HOST}/v2` },
      ],
    });
    const k = await key(h, {});
    const r = await post(h, k, { max_tokens: 3, messages: [{ role: "user", content: "FLAGME" }] });
    expect(r.status).toBe(400);
    expect(bill.calls).toHaveLength(1);
    expect((await post(h, k, { max_tokens: 3, messages: [{ role: "user", content: "fine" }] })).status).toBe(200);
  });

  it("a credential 403 (invalid api key) still counts toward the breaker and reads upstream_auth_failed", async () => {
    const h = await adminHarness(file());
    const k = await key(h, {});
    for (let i = 0; i < 3; i++) {
      const r = await post(h, k, { max_tokens: 3, messages: [{ role: "user", content: "BADKEY" }] });
      expect(r.status).toBe(502);
      expect(((await r.json()) as any).error.code).toBe("upstream_auth_failed");
    }
    const open = await post(h, k, { max_tokens: 3, messages: [{ role: "user", content: "fine" }] });
    expect(open.status).toBe(503);
    expect(((await open.json()) as any).error.code).toBe("circuit_open");
  });
});
