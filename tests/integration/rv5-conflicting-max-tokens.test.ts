/**
 * Review 2026-11-05 F1 over HTTP: a decoy max_completion_tokens next to a huge
 * max_tokens used to pass the output limit (RB6) and the quota reservation
 * (RB3) and both fields were forwarded. Now different values are a 400
 * conflicting_max_tokens before anything is sent upstream.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { adminHarness, FakeUpstreams, yamlTarget } from "./_admin-harness.js";

const up = new FakeUpstreams();
beforeAll(() => up.install());
afterAll(() => up.uninstall());
afterEach(() => up.reset());
const HOST = "a.upstream.test";

it("max_tokens 9,999,999 + max_completion_tokens 1 → 400 conflicting_max_tokens, nothing forwarded", async () => {
  const h = await adminHarness({ strategy: { mode: "single", targets: ["a"] }, targets: [yamlTarget("a", ["gpt-x"])] });
  const r0 = await h.admin("POST", "/keys", { name: "guest", quotaTokens: 1000 });
  const k = (await r0.json()) as { key: string };
  const send = (body: Record<string, unknown>) =>
    h.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }], ...body }),
    });
  const alone = await send({ max_tokens: 9_999_999 });
  expect(alone.status).toBe(400);
  const both = await send({ max_tokens: 9_999_999, max_completion_tokens: 1 });
  expect(both.status).toBe(400);
  const err = (await both.json()) as { error: { code: string; param: string } };
  expect(err.error.code).toBe("conflicting_max_tokens");
  expect(err.error.param).toBe("max_completion_tokens");
  expect(up.hits(HOST)).toHaveLength(0);
});
