import { describe, it, expect } from "bun:test";
import { setup, sse, post } from "./_h";
import { enforceUnsupportedParams } from "@/providers/capabilities";

const completion = (extra: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) => Response.json({
  id: "x", object: "chat.completion", created: 1, model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "ok", ...msg }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, ...extra,
});

describe("T3-8 provider capability enforcement is dead: config.compatibility never wired, name = target name", () => {
  it("compatibility.onUnsupportedParam=reject + mistral target: seed must be rejected (400), not sent", async () => {
    const s = setup(() => completion(), { compatibility: { onUnsupportedParam: "reject" } } as never, { name: "up", provider: "mistral" });
    try {
      const r = await post(s.app, { seed: 7 });
      expect(r.status).toBe(400); // BUG: 200, seed forwarded to mistral
    } finally { s.stop(); }
  });
  it("drop mode: unsupported snake/camel-mismatched fields are actually dropped", () => {
    const res = enforceUnsupportedParams("mistral", { model: "m", messages: [], streamOptions: { includeUsage: true }, seed: 1 } as never, "drop");
    expect(res.action).toBe("dropped");
    const req = (res as { request: Record<string, unknown> }).request;
    expect(req["seed"]).toBeUndefined();          // works (label == capability)
    expect(req["streamOptions"]).toBeUndefined(); // BUG: still present ("stream_options" never matches case "streamOptions")
  });
  it("drop mode on replicate: toolChoice/responseFormat/topLogprobs/maxCompletionTokens survive", () => {
    const res = enforceUnsupportedParams("replicate", { model: "m", messages: [], toolChoice: "auto", responseFormat: { type: "json_object" }, maxCompletionTokens: 5, presencePenalty: 1 } as never, "drop");
    const req = (res as { request: Record<string, unknown> }).request;
    expect([req["toolChoice"], req["responseFormat"], req["maxCompletionTokens"], req["presencePenalty"]]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("T3-9 provider-specific response fields / headers lost (definitions/*.ts unused by the gateway)", () => {
  it.failing("perplexity citations reach the client (non-stream)", async () => {
    const s = setup(() => completion({ citations: ["https://a.example"], search_results: [{ url: "https://a.example" }] }), {}, { provider: "perplexity" });
    try {
      const j = await (await post(s.app, {})).json() as Record<string, unknown>;
      expect(j["citations"]).toEqual(["https://a.example"]); // BUG: undefined
    } finally { s.stop(); }
  });
  it.failing("system_fingerprint / service_tier are preserved (non-stream)", async () => {
    const s = setup(() => completion({ system_fingerprint: "fp_1", service_tier: "default" }));
    try {
      const j = await (await post(s.app, {})).json() as Record<string, unknown>;
      expect(j["system_fingerprint"]).toBe("fp_1"); // BUG: dropped (only emitted from metadata, which no factory fills)
    } finally { s.stop(); }
  });
  it("openrouter target sends its HTTP-Referer attribution header", async () => {
    let referer: string | null = "unset";
    const s = setup((req) => { referer = req.headers.get("http-referer"); return completion(); }, {}, { provider: "openrouter" });
    try {
      await post(s.app, {});
      expect(referer).not.toBeNull(); // BUG: null — definitions/openrouter.ts extraHeaders unused
    } finally { s.stop(); }
  });
});

describe("T3-11 (known, still reproduces) protocol fields dropped", () => {
  it.failing("non-stream: reasoning_content / refusal / logprobs / usage details preserved", async () => {
    const s = setup(() => Response.json({
      id: "x", object: "chat.completion", created: 1, model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok", reasoning_content: "think", refusal: null }, logprobs: { content: [{ token: "ok", logprob: -0.1, bytes: [111, 107], top_logprobs: [] }] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 1 } },
    }));
    try {
      const j = await (await post(s.app, { logprobs: true })).json() as any;
      const got = { rc: j.choices[0].message.reasoning_content, lp: j.choices[0].logprobs, ptd: j.usage.prompt_tokens_details, ctd: j.usage.completion_tokens_details };
      console.log("non-stream got", JSON.stringify(got));
      expect(got.rc).toBe("think");
      expect(got.lp).not.toBeNull();
      expect(got.ptd).toEqual({ cached_tokens: 1 });
    } finally { s.stop(); }
  });
  it.failing("stream: delta.reasoning_content and choice logprobs forwarded", async () => {
    const s = setup(() => sse([
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking..." }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content: "ok" }, logprobs: { content: [{ token: "ok", logprob: -0.1 }] }, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 9 } } })}\n\n`,
      "data: [DONE]\n\n"]));
    try {
      const t = await (await post(s.app, { stream: true, logprobs: true })).text();
      expect(t).toContain("thinking...");    // BUG: dropped
      expect(t).toContain("\"logprob\"");     // BUG: logprobs:null
      expect(t).toContain("reasoning_tokens"); // BUG: usage details dropped on stream
    } finally { s.stop(); }
  });
  it.failing("request: tools[].function.strict, reasoning_effort, metadata, store, modalities forwarded", async () => {
    const s = setup(() => completion());
    try {
      await post(s.app, { reasoning_effort: "high", store: true, metadata: { a: "b" }, tools: [{ type: "function", function: { name: "f", strict: true, parameters: { type: "object" } } }] });
      const up = s.seen[0] as any;
      console.log("upstream got", JSON.stringify(up));
      expect(up.reasoning_effort).toBe("high");
      expect(up.tools[0].function.strict).toBe(true);
    } finally { s.stop(); }
  });
  it.failing("max-token plugin: request that omits max_tokens is not capped (bypass)", async () => {
    const s = setup(() => completion(), { plugins: [{ name: "max-token", stage: "before_request", config: { maxTokens: 100 } }] } as never);
    try {
      await post(s.app, {});
      const up = s.seen[0] as any;
      expect(up.max_tokens ?? up.max_completion_tokens).toBe(100); // BUG: undefined → model default (unbounded)
    } finally { s.stop(); }
  });
});

describe("T3-12 non-stream: malformed upstream 200 bodies -> opaque 500 'Internal server error'", () => {
  it.failing("200 with non-JSON body maps to 502 provider error", async () => {
    const s = setup(() => new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } }));
    try {
      const r = await post(s.app, {});
      expect(r.status).toBe(502); // BUG: 500 internal_error (SyntaxError escapes openai-compat.ts:153)
    } finally { s.stop(); }
  });
  it.failing("choices:[null] maps to 502, not a TypeError 500", async () => {
    const s = setup(() => Response.json({ id: "x", choices: [null] }));
    try {
      const r = await post(s.app, {});
      expect(r.status).toBe(502);
    } finally { s.stop(); }
  });
});
