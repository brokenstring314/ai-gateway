/**
 * Real DeepSeek smoke test (0.3.0 P7), opt-in: `bun run smoke:real`.
 *
 * Skipped (exit 0) unless DEEPSEEK_API_KEY is set. Spends a handful of real
 * requests (about 6 upstream calls): starts the real server with a temporary
 * data dir, creates a DeepSeek channel through the Admin API (public SSRF
 * policy, no test hooks), tests it, fetches the model list, publishes one
 * model, chats non-stream and stream through a gateway key with a token
 * quota, checks the usage was counted, that the next request after the quota
 * is used up gets 403 quota_exhausted (the admitted stream still finished),
 * that an unpublished model is 404 and an over-limit max_tokens is a 400
 * (never clamped), and reads the account balance.
 *
 * Env: DEEPSEEK_API_KEY (required), SMOKE_MODEL (default deepseek-v4-flash,
 * falls back to the first "flash"/"chat" model the account lists).
 */
import { randomBytes } from "node:crypto";
import { ADMIN_SECRET, startGateway } from "../tests/e2e/harness/gateway.ts";

process.env["NO_PROXY"] = [process.env["NO_PROXY"], "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env["no_proxy"] = process.env["NO_PROXY"];

const apiKey = process.env["DEEPSEEK_API_KEY"];
if (!apiKey) {
  console.log("smoke:real skipped: DEEPSEEK_API_KEY is not set");
  process.exit(0);
}

let upstreamCalls = 0;
const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const gw = await startGateway({
  config: {
    // The file needs one target; it is never called (everything below uses the Admin API channel).
    strategy: { mode: "single", targets: ["placeholder"] },
    targets: [
      { name: "placeholder", provider: "openai", apiKey: "sk-unused-0123456789", baseURL: "https://example.com/v1" },
    ],
    auth: { enabled: true },
    adminSecret: ADMIN_SECRET,
    requestTimeout: "60s",
  },
  env: { GATEWAY_SECRET_KEY: randomBytes(32).toString("base64"), USAGE_FLUSH_INTERVAL_MS: "200" },
});

async function admin<T = unknown>(method: string, path: string, body?: unknown, ifMatch?: number) {
  const res = await gw.fetch(`/admin${path}`, {
    method,
    auth: null,
    headers: {
      "X-Admin-Secret": ADMIN_SECRET,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(ifMatch !== undefined ? { "If-Match": `"${ifMatch}"` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json as T };
}

async function chat(key: string, model: string, extra: Record<string, unknown> = {}) {
  return gw.fetch("/v1/chat/completions", {
    method: "POST",
    auth: key,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
      max_tokens: 64,
      ...extra,
    }),
  });
}

try {
  // 1. Channel through the Admin API (public policy: the real SSRF guard and DNS).
  const created = await admin<{ id: string; revision: number }>("POST", "/channels", {
    name: "deepseek",
    preset: "deepseek",
    keys: [{ key: apiKey }],
  });
  check("create DeepSeek channel via Admin API", created.status === 201, `HTTP ${created.status}`);
  const chId = created.body.id;

  const tested = await admin<{ ok: boolean; latencyMs: number; error?: string }>("POST", `/channels/${chId}/test`, {});
  upstreamCalls++;
  check("channel test", tested.body?.ok === true, `${tested.body?.latencyMs} ms ${tested.body?.error ?? ""}`);

  const fetched = await admin<{ models: string[] }>("POST", `/channels/${chId}/fetch-models`, {});
  upstreamCalls++;
  const ids = fetched.body?.models ?? [];
  check("fetch models (GET /models upstream)", ids.length > 0, ids.join(", "));
  const wanted = process.env["SMOKE_MODEL"] ?? "deepseek-v4-flash";
  const model = ids.includes(wanted)
    ? wanted
    : (ids.find((m) => m.includes("flash")) ?? ids.find((m) => m.includes("chat")) ?? ids[0]!);
  check(`model to publish: ${model}`, ids.includes(model), ids.includes(wanted) ? "" : `${wanted} not listed`);

  // 2. Publish only that model (derived source: the channel's model list).
  const ch = await admin<{ revision: number }>("GET", `/channels/${chId}`);
  const pub = await admin("PATCH", `/channels/${chId}`, { models: [model] }, ch.body.revision);
  check("publish model", pub.status === 200, `HTTP ${pub.status}`);

  // 3. A client key with a token quota (lowered to "used + 1" after the first call, below).
  let quota = 100_000;
  const k = await admin<{ id: string; key: string }>("POST", "/keys", {
    name: "smoke",
    scopes: ["inference"],
    quotaTokens: quota,
  });
  check("create client key with quota", k.status === 201, `quotaTokens ${quota}`);
  const key = k.body.key;

  // 4. Product rules without spending a request: unpublished → 404, over-limit max_tokens → 400.
  const other = ids.find((m) => m !== model);
  if (other) {
    const r = await chat(key, other);
    check(`unpublished model ${other} → 404`, r.status === 404, `HTTP ${r.status}`);
  }
  const big = await chat(key, model, { max_tokens: 10_000_000 });
  const bigBody = (await big.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  check(
    "max_tokens over the model limit → 400 (rejected, not clamped)",
    big.status === 400,
    `HTTP ${big.status} ${bigBody.error?.code ?? ""}`,
  );

  // 5. Non-stream.
  const r1 = await chat(key, model);
  upstreamCalls++;
  const j1 = (await r1.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  const t1 = j1.usage?.total_tokens ?? 0;
  check("chat non-stream", r1.status === 200 && t1 > 0, `"${j1.choices?.[0]?.message?.content ?? ""}" ${t1} tokens`);

  // Lower the quota to just above what is used: the stream below is admitted and ends past it.
  let usedNow = 0;
  let rev = 0;
  for (let i = 0; i < 30 && usedNow < t1; i++) {
    const keys = await admin<{ keys: Array<{ id: string; usedTokens: number; revision: number }> }>("GET", "/keys");
    const me = keys.body.keys.find((x) => x.id === k.body.id);
    usedNow = me?.usedTokens ?? 0;
    rev = me?.revision ?? 0;
    if (usedNow < t1) await Bun.sleep(200);
  }
  quota = usedNow + 1;
  const lowered = await admin("PATCH", `/keys/${k.body.id}`, { quotaTokens: quota }, rev);
  check("lower quota to used + 1", lowered.status === 200, `quotaTokens ${quota} (HTTP ${lowered.status})`);

  // 6. Stream with usage; admitted below the quota, ends above it, never cut.
  const r2 = await chat(key, model, { stream: true, stream_options: { include_usage: true } });
  upstreamCalls++;
  const sse = await r2.text();
  const t2 = [...sse.matchAll(/"total_tokens":(\d+)/g)].map((m) => Number(m[1])).at(-1) ?? 0;
  const streamed = [...sse.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
  check(
    "chat stream finished ([DONE], usage chunk)",
    r2.status === 200 && sse.trimEnd().endsWith("data: [DONE]") && t2 > 0,
    `"${streamed}" ${t2} tokens`,
  );

  // 7. Usage counted on the key (asynchronous flush).
  let used = 0;
  for (let i = 0; i < 30; i++) {
    const keys = await admin<{ keys: Array<{ id: string; usedTokens: number }> }>("GET", "/keys");
    used = keys.body.keys.find((x) => x.id === k.body.id)?.usedTokens ?? 0;
    if (used >= t1 + t2) break;
    await Bun.sleep(200);
  }
  check("usage counted on the key", used === t1 + t2, `usedTokens ${used} = ${t1} + ${t2}`);

  // 8. Quota used up by the admitted stream → the next request is refused before it starts.
  check("the admitted stream ended past the quota", used > quota, `used ${used} > quota ${quota}`);
  const over = await chat(key, model);
  const overBody = (await over.json().catch(() => ({}))) as { error?: { code?: string; type?: string } };
  check(
    "quota used up → 403 quota_exhausted (type insufficient_quota)",
    over.status === 403 && overBody.error?.code === "quota_exhausted",
    `used ${used} ≥ quota ${quota}; HTTP ${over.status} ${overBody.error?.type ?? ""}/${overBody.error?.code ?? ""}`,
  );

  // 9. Usage report (no money anywhere: tokens and requests only).
  const usage = await admin<{ totals: { requests: number; totalTokens: number } }>("GET", "/usage?groupBy=key");
  check(
    "GET /admin/usage",
    usage.status === 200 && usage.body.totals.requests >= 2,
    `requests ${usage.body?.totals?.requests}, tokens ${usage.body?.totals?.totalTokens}`,
  );
  check("no price/cost fields in the usage report", !/cost|price|usd/i.test(JSON.stringify(usage.body)));

  // 10. Account balance (informational).
  const bal = await admin<{
    supported: boolean;
    ok?: boolean;
    available?: boolean;
    balances?: Array<{ currency: string; total: string }>;
    error?: string;
  }>("GET", `/channels/${chId}/balance`);
  upstreamCalls++;
  check(
    "GET /admin/channels/:id/balance",
    bal.status === 200 && bal.body.supported === true && bal.body.ok === true && (bal.body.balances?.length ?? 0) > 0,
    `${(bal.body?.balances ?? []).map((b) => `${b.total} ${b.currency}`).join(" · ")} available=${bal.body?.available} ${bal.body?.error ?? ""}`,
  );
} catch (err) {
  check("unexpected error", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await gw.stop();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ~${upstreamCalls} upstream calls`);
if (failed.length > 0) {
  console.log(gw.logs().slice(-3000));
  process.exit(1);
}
