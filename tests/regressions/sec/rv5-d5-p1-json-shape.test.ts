/**
 * Red team 2026-11-05
 *  - D5: 100,000 nested arrays in tools[].function.parameters overflowed the
 *    stack after JSON.parse; the local RangeError was counted as an upstream
 *    failure (breaker + failover): three requests from an RPM-limited key
 *    opened the circuit for everyone without touching the upstream
 *    (repros/abuse-data/t8_deep_json_breaker.sh).
 *  - P1: a pass-through body with "model" twice was checked against the
 *    key's allowedModels with the LAST value and routed with the FIRST, so a
 *    key limited to "cheap" reached the "exp" channel with its upstream key
 *    (repros/perimeter/t_dupkey.sh).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { classifyAttemptError, isFailoverEligible, isLocalError } from "@/core/outcome";
import { Gateway } from "@/gateway";
import { KeyStore } from "@/persistence/key-store";
import { ProviderError } from "@/providers/openai-compat";
import { inspectJson, MAX_JSON_DEPTH } from "@/security/json-guard";
import { chatJson, fakeFetch, target } from "../core/_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;

describe("D5 deep JSON", () => {
  it("inspectJson counts depth outside strings only", () => {
    expect(inspectJson(nested(MAX_JSON_DEPTH)).tooDeep).toBe(false);
    expect(inspectJson(nested(MAX_JSON_DEPTH + 1)).tooDeep).toBe(true);
    expect(inspectJson(`{"a":"${"[".repeat(5000)}"}`).tooDeep).toBe(false);
    expect(inspectJson(`{"a":"\\"${"{".repeat(500)}"}`).tooDeep).toBe(false);
  });

  it("t8 repro: deep tools parameters are a 400 and cannot open the breaker", async () => {
    const f = fakeFetch(() => chatJson("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    restore = f.restore;
    const config = loadConfigFromObject({
      strategy: { mode: "single" },
      targets: [target("mock", ["m"], { circuitBreaker: { failureThreshold: 3, timeoutMs: 30_000 } })],
      auth: { enabled: true },
    });
    const store = await KeyStore.create(new Database(":memory:"));
    const victim = store.create("victim", ["inference"]).key;
    const attacker = store.create("attacker", ["inference"], undefined, { rpm: 60 }).key;
    const app = createApp(new Gateway(config), config, undefined, store);
    const send = (key: string, body: string) =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
      });
    const ok = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect((await send(victim, ok)).status).toBe(200);
    const deepBody =
      `{"model":"m","messages":[{"role":"user","content":"x"}],"tools":[{"type":"function","function":` +
      `{"name":"f","parameters":{"p":${nested(100_000)}}}}]}`;
    for (let i = 0; i < 3; i++) {
      const r = await send(attacker, deepBody);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("json_too_deep");
    }
    expect((await send(victim, ok)).status).toBe(200); // was 503 circuit_open
    expect(f.calls.length).toBe(2); // only the victim's two requests reached the upstream
  });

  it("a depth-limit body on the other typed routes and on pass-through is a 400 too", async () => {
    const f = fakeFetch(() => Response.json({}));
    restore = f.restore;
    const config = loadConfigFromObject({
      strategy: { mode: "single" },
      targets: [target("a")],
      auth: { enabled: false },
      passthroughProxy: { enabled: true },
    });
    const app = createApp(new Gateway(config), config);
    const deep = `{"model":"m","input":${nested(MAX_JSON_DEPTH + 5)},"prompt":"x"}`;
    for (const path of ["/v1/completions", "/v1/embeddings", "/v1/images/generations", "/v1/responses"]) {
      const r = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: deep,
      });
      expect([path, r.status]).toEqual([path, 400]);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("json_too_deep");
    }
    expect(f.calls.length).toBe(0);
  });

  it("local engine errors never count as upstream failures and never fail over", () => {
    const facts = { admitted: true } as const;
    for (const e of [new RangeError("Maximum call stack size exceeded"), new TypeError("x is undefined")]) {
      expect(isLocalError(e)).toBe(true);
      expect(classifyAttemptError(e, facts).breaker).toBe("release");
      expect(isFailoverEligible(e)).toBe(false);
    }
    // Transport / upstream failures are unchanged.
    const transport = new ProviderError("t", 0, "fetch failed: ECONNRESET");
    expect(isLocalError(transport)).toBe(false);
    expect(classifyAttemptError(transport, facts).breaker).toBe("failure");
    expect(isFailoverEligible(transport)).toBe(true);
    expect(classifyAttemptError(new ProviderError("t", 503, "down"), facts).breaker).toBe("failure");
  });

  it("a provider throwing a local RangeError does not trip the breaker or try the next target", async () => {
    const f = fakeFetch(() => chatJson("ok"));
    restore = f.restore;
    const config = loadConfigFromObject({
      strategy: { mode: "fallback", targets: ["a", "b"] },
      targets: [target("a", ["m"], { circuitBreaker: { failureThreshold: 1, timeoutMs: 30_000 } }), target("b", ["m"])],
      auth: { enabled: false },
    });
    const gw = new Gateway(config);
    const provider = gw.getRegistry().get("a") as { complete: (...a: unknown[]) => unknown };
    const original = provider.complete;
    provider.complete = () => Promise.reject(new RangeError("Maximum call stack size exceeded"));
    const app = createApp(gw, config);
    const ok = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const r = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ok,
    });
    expect(r.status).toBe(500);
    expect(f.calls.length).toBe(0); // b was not tried
    provider.complete = original;
    const again = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ok,
    });
    expect(again.status).toBe(200); // a's breaker is still closed
    expect(f.calls[0]!.url).toContain("a.upstream.test");
  });
});

describe("P1 duplicate top-level keys on pass-through", () => {
  async function setup() {
    const f = fakeFetch((url) => Response.json({ id: "r", object: "response", url: url.hostname }));
    restore = f.restore;
    const config = loadConfigFromObject({
      strategy: { mode: "single" },
      targets: [target("cheap", ["cheap"]), target("exp", ["exp"])],
      auth: { enabled: true },
      passthroughProxy: { enabled: true },
    });
    const store = await KeyStore.create(new Database(":memory:"));
    const key = store.create("r", ["inference"], undefined, { allowedModels: ["cheap"] }).key;
    const app = createApp(new Gateway(config), config, undefined, store);
    const send = (body: string) =>
      app.request("/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
      });
    return { send, calls: f.calls };
  }

  it("t_dupkey repro: {model: exp, model: cheap} is a 400 and reaches no channel", async () => {
    const { send, calls } = await setup();
    expect((await send('{"model":"exp","input":"x"}')).status).toBe(403);
    const r = await send('{"model":"exp","model":"cheap","input":"x"}'); // was 200 via chan-exp
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("duplicate_json_key");
    expect(calls.length).toBe(0);
  });

  it("escaped spellings of the same key are duplicates too; nested repeats are fine", async () => {
    const { send, calls } = await setup();
    expect((await send('{"model":"exp","mod\\u0065l":"cheap","input":"x"}')).status).toBe(400);
    expect((await send('{"input":"x","input":"y","model":"cheap"}')).status).toBe(400);
    const ok = await send('{"model":"cheap","input":[{"model":"a"},{"model":"b"}],"metadata":{"k":1}}');
    expect(ok.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("cheap.upstream.test");
  });
});
