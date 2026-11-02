/**
 * Per-key limits and usage statistics (0.3.0 P5) through the real Hono app:
 * token quota (admission only; admitted streams always finish), RPM / TPM
 * per key vs the global rate-limit plugin, PATCH /admin/keys/:id with
 * If-Match, reset-usage, counters surviving Gateway.reload, GET
 * /admin/usage grouping / date ranges / time zones, and permissions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { loadConfigFromObject } from "../../src/config/loader.js";
import { HOUR_MS } from "../../src/usage/usage-store.js";
import { adminHarness, FakeUpstreams, type Harness, yamlTarget } from "./_admin-harness.js";

const up = new FakeUpstreams();
beforeAll(() => up.install());
afterAll(() => up.uninstall());
afterEach(() => up.reset());

const HOST = "a.upstream.test";

function file(extra: Record<string, unknown> = {}) {
  return {
    strategy: { mode: "single", targets: ["a"] },
    targets: [yamlTarget("a", ["gpt-x", "gpt-y"])],
    aliases: { fast: "gpt-x" },
    ...extra,
  };
}

/** SSE body with a trailing usage chunk of `total` tokens (prompt 10). */
function sseWithUsage(total: number, content = "hello world"): string {
  const c = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-x" };
  return (
    c({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }) +
    c({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    c({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: total - 10,
        total_tokens: total,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }) +
    "data: [DONE]\n\n"
  );
}

function jsonWithUsage(total: number) {
  return {
    status: 200,
    body: {
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "gpt-x",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: total - 1, total_tokens: total, prompt_cache_hit_tokens: 1 },
    },
  };
}

async function createKey(h: Harness, body: Record<string, unknown>): Promise<{ id: string; key: string }> {
  const r = await h.admin("POST", "/keys", { name: "guest", ...body });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; key: string };
}

async function getKey(h: Harness, id: string): Promise<any> {
  const r = await h.admin("GET", `/keys/${id}`);
  expect(r.status).toBe(200);
  return r.json();
}

function chat(h: Harness, key: string, body: Record<string, unknown> = {}) {
  return h.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

describe("token quota", () => {
  it("an admitted stream finishes past the quota; the next request gets 403 quota_exhausted", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, { quotaTokens: 30 });
    up.enqueue(HOST, { status: 200, headers: { "content-type": "text/event-stream" }, text: sseWithUsage(100) });
    const r = await chat(h, k.key, { stream: true, stream_options: { include_usage: true } });
    expect(r.status).toBe(200);
    const text = await r.text();
    // The whole stream arrived: content, usage chunk and [DONE] — nothing was cut for quota.
    expect(text).toContain("hello world");
    expect(text).toContain('"total_tokens":100');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const view = await getKey(h, k.id);
    expect(view).toMatchObject({ quotaTokens: 30, usedTokens: 100, remainingTokens: 0, quotaExhausted: true });

    const refused = await chat(h, k.key);
    expect(refused.status).toBe(403);
    const err = ((await refused.json()) as any).error;
    expect(err.code).toBe("quota_exhausted");
    expect(err.type).toBe("insufficient_quota");
    expect(refused.headers.get("retry-after")).toBeNull();
    // Refused before any upstream call.
    expect(up.hits(HOST)).toHaveLength(1);
  });

  it("concurrent streams admitted before exhaustion all finish; the one after is refused", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, { quotaTokens: 50 });
    for (let i = 0; i < 3; i++) {
      up.enqueue(HOST, { status: 200, headers: { "content-type": "text/event-stream" }, text: sseWithUsage(40) });
    }
    // All three are admitted (their first chunk is primed) before any finishes.
    const open = await Promise.all([0, 1, 2].map(() => chat(h, k.key, { stream: true })));
    expect(open.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = [];
    for (const r of open) bodies.push(await r.text());
    for (const b of bodies) expect(b.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect((await getKey(h, k.id)).usedTokens).toBe(120);
    expect((await chat(h, k.key)).status).toBe(403);
  });

  it("a stream the client abandons after the first chunk is still counted (no quota bypass)", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, { quotaTokens: 1 });
    const r = await chat(h, k.key, { stream: true });
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    for (let i = 0; i < 50 && ((await getKey(h, k.id)).usedTokens ?? 0) === 0; i++) await Bun.sleep(10);
    expect((await getKey(h, k.id)).usedTokens).toBeGreaterThan(0);
    expect((await chat(h, k.key)).status).toBe(403);
  });

  it("image generation cannot be metered in tokens: keys with a quota get 403 quota_not_metered", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, { quotaTokens: 1_000 });
    const r = await h.app.request("/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", prompt: "a cat" }),
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe("quota_not_metered");
    expect(up.hits(HOST)).toHaveLength(0);
  });

  it("a stream without a usage chunk is counted by estimate", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, { quotaTokens: 1_000 });
    const r = await chat(h, k.key, { stream: true });
    await r.text();
    expect((await getKey(h, k.id)).usedTokens).toBeGreaterThan(0);
  });

  it("raising the quota (PATCH) or reset-usage re-opens an exhausted key", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, { quotaTokens: 5 });
    up.enqueue(HOST, jsonWithUsage(10));
    expect((await chat(h, k.key)).status).toBe(200);
    expect((await chat(h, k.key)).status).toBe(403);

    const etag = (await h.admin("GET", `/keys/${k.id}`)).headers.get("etag")!;
    const patched = await h.admin("PATCH", `/keys/${k.id}`, { quotaTokens: 20 }, { ifMatch: etag });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ quotaTokens: 20, usedTokens: 10, remainingTokens: 10 });
    expect((await chat(h, k.key)).status).toBe(200);

    const reset = await h.admin("POST", `/keys/${k.id}/reset-usage`);
    expect(reset.status).toBe(200);
    const after = (await reset.json()) as any;
    expect(after.usedTokens).toBe(0);
    expect(after.usageResetAt).toBeString();
    // Persisted at once.
    expect(h.keyStore.get(k.id)!.usedTokens).toBe(0);
  });
});

describe("RPM / TPM per key vs the global rate-limit plugin", () => {
  const withPlugin = (config: Record<string, unknown>) =>
    file({ plugins: [{ name: "rate-limit", stage: "before_request", config }] });

  it("a key's own RPM replaces the plugin's per-minute limit; keys without one use the plugin", async () => {
    const h = await adminHarness(withPlugin({ maxRequestsPerMinute: 2 }));
    const own = await createKey(h, { rpm: 4 });
    const plain = await createKey(h, {});
    for (let i = 0; i < 4; i++) expect((await chat(h, own.key)).status).toBe(200);
    const fifth = await chat(h, own.key);
    expect(fifth.status).toBe(429);
    expect(((await fifth.json()) as any).error.code).toBe("rate_limit_exceeded");
    expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);

    expect((await chat(h, plain.key)).status).toBe(200);
    expect((await chat(h, plain.key)).status).toBe(200);
    const third = await chat(h, plain.key);
    expect(third.status).toBe(429);
    expect(((await third.json()) as any).error.code).toBe("plugin_rejected");
  });

  it("TPM: own value per key, else the plugin's maxTokensPerMinute; no plugin → unlimited", async () => {
    const h = await adminHarness(withPlugin({ maxTokensPerMinute: 15 }));
    const own = await createKey(h, { tpm: 25 });
    const plain = await createKey(h, {});
    for (let i = 0; i < 6; i++) up.enqueue(HOST, jsonWithUsage(10));
    // own: 0 → 10 → 20 admitted, then 20 + 10 = 30 ≥ 25 refused.
    for (let i = 0; i < 3; i++) expect((await chat(h, own.key)).status).toBe(200);
    const r = await chat(h, own.key);
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error.message).toContain("25 tokens per minute");
    // plain: global 15 → 0, 10 admitted, 20 ≥ 15 refused.
    expect((await chat(h, plain.key)).status).toBe(200);
    expect((await chat(h, plain.key)).status).toBe(200);
    expect((await chat(h, plain.key)).status).toBe(429);

    const free = await adminHarness(file());
    const k = await createKey(free, {});
    for (let i = 0; i < 5; i++) up.enqueue(HOST, jsonWithUsage(1000));
    for (let i = 0; i < 5; i++) expect((await chat(free, k.key)).status).toBe(200);
  });
});

describe("counters survive a config reload", () => {
  it("quota, RPM and TPM windows are not reset by Gateway.reload", async () => {
    const h = await adminHarness(
      file({ plugins: [{ name: "rate-limit", stage: "before_request", config: { tpm: 15 } }] }),
    );
    const q = await createKey(h, { quotaTokens: 5 });
    const r = await createKey(h, { rpm: 1 });
    const t = await createKey(h, {});
    for (let i = 0; i < 4; i++) up.enqueue(HOST, jsonWithUsage(10));
    expect((await chat(h, q.key)).status).toBe(200);
    expect((await chat(h, r.key)).status).toBe(200);
    expect((await chat(h, t.key)).status).toBe(200);
    expect((await chat(h, t.key)).status).toBe(200); // 10 < 15

    // Reload twice through the Admin API (each write builds and swaps a new snapshot).
    for (const aliases of [{ quick: "gpt-x" }, { quick: "gpt-y" }]) {
      const etag = (await h.admin("GET", "/settings")).headers.get("etag")!;
      expect((await h.admin("PATCH", "/settings", { aliases }, { ifMatch: etag })).status).toBe(200);
    }
    // Also a plain embedded reload with the same config.
    h.gateway.reload(loadConfigFromObject(h.gateway.getConfig() as never));

    expect((await chat(h, q.key)).status).toBe(403);
    expect((await chat(h, r.key)).status).toBe(429);
    expect((await chat(h, t.key)).status).toBe(429); // 20 ≥ 15
  });
});

describe("PATCH /admin/keys/:id", () => {
  it("needs If-Match (428), refuses a stale one (409), validates strictly and audits", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, {});
    expect((await h.admin("PATCH", `/keys/${k.id}`, { rpm: 5 })).status).toBe(428);
    const etag = (await h.admin("GET", `/keys/${k.id}`)).headers.get("etag")!;
    expect((await h.admin("PATCH", `/keys/${k.id}`, { rpm: 0 }, { ifMatch: etag })).status).toBe(400);
    expect((await h.admin("PATCH", `/keys/${k.id}`, { quotaUsd: 5 }, { ifMatch: etag })).status).toBe(400);
    expect((await h.admin("PATCH", `/keys/${k.id}`, { quotaTokens: 1.5 }, { ifMatch: etag })).status).toBe(400);
    const ok = await h.admin(
      "PATCH",
      `/keys/${k.id}`,
      { name: "friend", rpm: 5, tpm: 1000, quotaTokens: 1_000_000, allowedModels: ["gpt-x"], expiresAt: null },
      { ifMatch: etag },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body).toMatchObject({ name: "friend", rpm: 5, tpm: 1000, quotaTokens: 1_000_000, allowedModels: ["gpt-x"] });
    expect(ok.headers.get("etag")).toBe(`"${body.revision}"`);
    const stale = await h.admin("PATCH", `/keys/${k.id}`, { rpm: 6 }, { ifMatch: etag });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).error.currentRevision).toBe(body.revision);
    // null clears a limit.
    const cleared = await h.admin("PATCH", `/keys/${k.id}`, { rpm: null }, { ifMatch: body.revision });
    expect(((await cleared.json()) as any).rpm).toBeNull();
    expect((await h.admin("PATCH", "/keys/nope", { rpm: 1 }, { ifMatch: 1 })).status).toBe(404);

    const audit = ((await (await h.admin("GET", "/audit")).json()) as any).data;
    const actions = audit.filter((a: any) => a.resourceId === k.id).map((a: any) => a.action);
    expect(actions).toContain("key_create");
    expect(actions.filter((a: string) => a === "key_update")).toHaveLength(2);
    const reset = await h.admin("POST", `/keys/${k.id}/reset-usage`, undefined, { ifMatch: 1 });
    expect(reset.status).toBe(409);
  });

  it("permissions: read_only may read keys and usage but not change them; inference keys get neither", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, {});
    const etag = (await h.admin("GET", `/keys/${k.id}`)).headers.get("etag")!;
    const ro = { key: h.keys.readOnly };
    expect((await h.admin("GET", `/keys/${k.id}`, undefined, ro)).status).toBe(200);
    expect((await h.admin("GET", "/usage", undefined, ro)).status).toBe(200);
    expect((await h.admin("PATCH", `/keys/${k.id}`, { rpm: 1 }, { ...ro, ifMatch: etag })).status).toBe(403);
    expect((await h.admin("POST", `/keys/${k.id}/reset-usage`, undefined, ro)).status).toBe(403);
    const inf = { key: h.keys.inference };
    expect((await h.admin("GET", "/usage", undefined, inf)).status).toBe(403);
    expect((await h.admin("POST", `/keys/${k.id}/reset-usage`, undefined, inf)).status).toBe(403);
    expect((await h.admin("GET", "/usage", undefined, { key: null })).status).toBe(401);
    // CSRF guard applies to the new writes too.
    const cross = await h.admin("POST", `/keys/${k.id}/reset-usage`, undefined, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
  });
});

describe("GET /admin/usage", () => {
  it("groups by key, model and channel with token details, errors and latency", async () => {
    const h = await adminHarness(file());
    const a = await createKey(h, { name: "alice" });
    const b = await createKey(h, { name: "bob", allowedModels: ["gpt-y"] });
    up.enqueue(HOST, jsonWithUsage(10), jsonWithUsage(20));
    expect((await chat(h, a.key)).status).toBe(200);
    expect((await chat(h, a.key, { model: "fast" })).status).toBe(200); // alias → gpt-x
    up.enqueue(HOST, { status: 200, headers: { "content-type": "text/event-stream" }, text: sseWithUsage(30) });
    expect((await (await chat(h, b.key, { model: "gpt-y", stream: true })).text()).length).toBeGreaterThan(0);
    expect((await chat(h, b.key)).status).toBe(403); // model not allowed: an error, no tokens

    const byKey = (await (await h.admin("GET", "/usage?groupBy=key")).json()) as any;
    expect(byKey.groupBy).toBe("key");
    expect(byKey.tz).toBe("UTC");
    const alice = byKey.data.find((d: any) => d.key === a.id);
    expect(alice).toMatchObject({ name: "alice", kind: "store", requests: 2, errors: 0, totalTokens: 30 });
    expect(alice.cacheHitTokens).toBe(2);
    const bob = byKey.data.find((d: any) => d.key === b.id);
    expect(bob).toMatchObject({ name: "bob", requests: 2, errors: 1, inputTokens: 10, outputTokens: 20 });
    expect(bob.cacheHitTokens).toBe(4);
    expect(bob.reasoningTokens).toBe(3);
    expect(bob.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(byKey.totals).toMatchObject({ requests: 4, errors: 1, totalTokens: 60 });
    for (const text of [JSON.stringify(byKey)]) {
      expect(text).not.toContain(a.key);
      expect(text).not.toMatch(/cost|price|usd/i);
    }

    const byModel = (await (await h.admin("GET", "/usage?groupBy=model")).json()) as any;
    const models = Object.fromEntries(byModel.data.map((d: any) => [d.model, d.requests]));
    expect(models).toEqual({ "gpt-x": 3, "gpt-y": 1 });

    const byChannel = (await (await h.admin("GET", "/usage?groupBy=channel")).json()) as any;
    const channels = Object.fromEntries(byChannel.data.map((d: any) => [d.channel, d.requests]));
    expect(channels).toEqual({ a: 3, none: 1 });
  });

  it("date ranges and time zones: buckets are UTC hours, days follow tz", async () => {
    const h = await adminHarness(file());
    // 2026-03-01 23:30 UTC = 2026-03-02 07:30 in Shanghai; 2026-03-02 10:00 UTC = 18:00 Shanghai.
    const at = (iso: string) => Math.floor(Date.parse(iso) / HOUR_MS);
    const counts = {
      requests: 1,
      errors: 0,
      inputTokens: 1,
      outputTokens: 1,
      cacheHitTokens: 0,
      reasoningTokens: 0,
      estimatedRequests: 0,
      latencyMsSum: 10,
      latencyMsMax: 10,
    };
    h.usageStore.add([
      { hour: at("2026-03-01T23:30:00Z"), keyId: "k1", model: "m", channel: "c", ...counts },
      { hour: at("2026-03-02T10:00:00Z"), keyId: "k1", model: "m", channel: "c", ...counts },
      { hour: at("2026-03-05T10:00:00Z"), keyId: "k1", model: "m", channel: "c", ...counts },
    ]);
    const q = async (qs: string) => (await (await h.admin("GET", `/usage?groupBy=key&${qs}`)).json()) as any;
    expect((await q("from=2026-03-01&to=2026-03-01")).totals.requests).toBe(1);
    expect((await q("from=2026-03-02&to=2026-03-02")).totals.requests).toBe(1);
    const sh = await q("from=2026-03-02&to=2026-03-02&tz=Asia/Shanghai");
    expect(sh.tz).toBe("Asia/Shanghai");
    expect(sh.totals.requests).toBe(2);
    expect((await q("from=2026-03-01&to=2026-03-01&tz=Asia/Shanghai")).totals.requests).toBe(0);
    const daily = await q("from=2026-03-01&to=2026-03-31&daily=true");
    expect(daily.data[0].daily.map((d: any) => [d.date, d.requests])).toEqual([
      ["2026-03-01", 1],
      ["2026-03-02", 1],
      ["2026-03-05", 1],
    ]);
    // A deleted / unknown key id is reported as such.
    expect(daily.data[0]).toMatchObject({ key: "k1", name: null, kind: "deleted" });
  });

  it("rejects bad parameters with 400", async () => {
    const h = await adminHarness(file());
    for (const qs of [
      "groupBy=user",
      "from=2026-02-30",
      "to=yesterday",
      "from=2026-03-02&to=2026-03-01",
      "from=2020-01-01&to=2026-01-01",
      "tz=Mars/Olympus",
      "daily=yes",
    ]) {
      expect((await h.admin("GET", `/usage?${qs}`)).status).toBe(400);
    }
  });
});

describe("no prices anywhere (0.3.0)", () => {
  it("channel settings with cost rates are refused with the removal hint", async () => {
    const h = await adminHarness(file());
    const r = await h.admin("POST", "/channels", {
      name: "priced",
      preset: "openai",
      baseURL: "https://priced.upstream.test/v1",
      settings: { costPer1kInputTokens: 0.1 },
      keys: [{ key: "sk-priced-0123456789abcd" }],
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("removed in 0.3.0");
  });

  it("key responses carry tokens only", async () => {
    const h = await adminHarness(file());
    const k = await createKey(h, { quotaTokens: 10 });
    const text = JSON.stringify(await getKey(h, k.id));
    expect(text).not.toMatch(/cost|price|usd|budget/i);
  });
});

describe("config-file keys in usage", () => {
  it("are reported as cfg_<index>, never derived from the key", async () => {
    const secret = "sk-owner-config-key-0123456789";
    const h = await adminHarness(file({ auth: { enabled: true, keys: ["sk-other-config-key-000", secret] } }));
    expect((await chat(h, secret)).status).toBe(200);
    const usage = (await (await h.admin("GET", "/usage?groupBy=key")).json()) as any;
    expect(usage.data).toHaveLength(1);
    expect(usage.data[0]).toMatchObject({ key: "cfg_1", kind: "config", requests: 1 });
  });
});
