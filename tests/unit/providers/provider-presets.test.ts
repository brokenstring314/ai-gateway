// 1.4: one provider presets table; capability checks keyed on target.provider
// (not the target name), config.compatibility wired, camel/snake fixed (T3-8);
// preset headers sent (T3-9 header part); ${VAR} baseURL accepted (C3-10).
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { safeParseConfig } from "@/config/schema";
import type { GatewayConfig } from "@/config/types";
import { enforceUnsupportedParams } from "@/providers/capabilities";
import { PROVIDER_PRESETS, baseURLProblem, createProviderFromTarget } from "@/core/provider-presets";

type Seen = { url: string; headers: Headers; body: Record<string, unknown> };
let seen: Seen[];
let fetchSpy: ReturnType<typeof spyOn>;

const completion = () =>
  Response.json({
    id: "c1", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

beforeEach(() => {
  seen = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return completion();
  }) as unknown as typeof fetch);
});
afterEach(() => fetchSpy.mockRestore());

function app(target: Record<string, unknown>, extra: Partial<GatewayConfig> = {}) {
  const config = {
    auth: { enabled: false },
    strategy: { mode: "single", targets: ["up"] },
    targets: [{ name: "up", apiKey: "sk", baseURL: "http://up.test/v1", models: ["m"], ...target }],
    ...extra,
  } as GatewayConfig;
  return createApp(new Gateway(config), config);
}
const post = (a: ReturnType<typeof app>, body: Record<string, unknown>) =>
  a.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], ...body }),
  });

describe("capabilities keyed on target.provider + compatibility wired (T3-8)", () => {
  it("reject: mistral target named 'up' rejects seed with 400, nothing sent upstream", async () => {
    const r = await post(app({ provider: "mistral" }, { compatibility: { onUnsupportedParam: "reject" } }), { seed: 7 });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("seed");
    expect(seen.length).toBe(0);
  });

  it("drop: unsupported params are removed from the upstream body", async () => {
    const r = await post(app({ provider: "mistral" }, { compatibility: { onUnsupportedParam: "drop" } }), {
      seed: 7,
      stream_options: { include_usage: true },
      temperature: 0.5,
    });
    expect(r.status).toBe(200);
    expect(seen[0]!.body["seed"]).toBeUndefined();
    expect(seen[0]!.body["stream_options"]).toBeUndefined();
    expect(seen[0]!.body["temperature"]).toBe(0.5);
  });

  it("warn (default): params pass through", async () => {
    const r = await post(app({ provider: "mistral" }), { seed: 7 });
    expect(r.status).toBe(200);
    expect(seen[0]!.body["seed"]).toBe(7);
  });

  it("drop on replicate removes camel/snake-mismatched fields too", () => {
    const res = enforceUnsupportedParams("replicate", {
      model: "m", messages: [], toolChoice: "auto", responseFormat: { type: "json_object" },
      maxCompletionTokens: 5, presencePenalty: 1, topLogprobs: 2, streamOptions: { includeUsage: true }, temperature: 1,
    } as never, "drop");
    expect(res.action).toBe("dropped");
    const req = (res as { request: Record<string, unknown> }).request;
    for (const k of ["toolChoice", "responseFormat", "maxCompletionTokens", "presencePenalty", "topLogprobs", "streamOptions"]) {
      expect(req[k]).toBeUndefined();
    }
    expect(req["temperature"]).toBe(1);
  });

  it("developer role: rejected on ollama in reject mode, mapped to system in drop mode", () => {
    const req = { model: "m", messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "hi" }] } as never;
    const rej = enforceUnsupportedParams("ollama", req, "reject");
    expect(rej.action).toBe("rejected");
    expect((rej as { reason: string }).reason).toContain("developer_role");
    const drop = enforceUnsupportedParams("ollama", req, "drop") as { request: { messages: Array<{ role: string }> } };
    expect(drop.request.messages[0]!.role).toBe("system");
    expect(enforceUnsupportedParams("openai", req, "reject").action).toBe("ok");
  });
});

describe("presets", () => {
  it("openrouter targets send the attribution header (T3-9)", async () => {
    await post(app({ provider: "openrouter" }), {});
    expect(seen[0]!.headers.get("http-referer")).toBeTruthy();
  });

  it("a target without baseURL uses the preset default", async () => {
    await post(app({ provider: "deepseek", baseURL: undefined }), {});
    expect(seen[0]!.url).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("provider aliases (nvidia-nim) resolve to the same preset", () => {
    expect(baseURLProblem({ name: "n", provider: "nvidia-nim" })).toBeUndefined();
    expect(PROVIDER_PRESETS["nvidia_nim"]?.baseURL).toContain("nvidia");
  });

  it("account-specific providers and unknown providers need an explicit baseURL", () => {
    expect(baseURLProblem({ name: "d", provider: "databricks" })).toContain("needs an explicit baseURL");
    expect(baseURLProblem({ name: "c", provider: "cloudflare" })).toContain("needs an explicit baseURL");
    expect(baseURLProblem({ name: "x", provider: "my-vllm" })).toContain('unknown provider "my-vllm" needs a baseURL');
    expect(baseURLProblem({ name: "x", provider: "my-vllm", baseURL: "http://vllm:8000/v1" })).toBeUndefined();
    expect(() => new Gateway({ strategy: { mode: "single" }, targets: [{ name: "d", provider: "databricks", apiKey: "k" }] } as GatewayConfig))
      .toThrow(/explicit baseURL/);
  });
});

describe("${VAR} in baseURL (C3-10)", () => {
  const parse = (baseURL: string) =>
    safeParseConfig({ strategy: { mode: "single" }, targets: [{ name: "a", provider: "openai", apiKey: "${K}", baseURL }] });

  for (const u of ["${OPENAI_BASE_URL}", "http://localhost:${PORT}/v1", "https://${AZ_RESOURCE}.openai.azure.com/v1"]) {
    it(`schema accepts ${u}`, () => expect(parse(u).success).toBe(true));
  }

  it("schema still rejects a plain non-URL", () => expect(parse("not a url").success).toBe(false));

  it("expanded at provider construction and validated as a URL", async () => {
    process.env["P14_BASE"] = "http://expanded.test/v1";
    process.env["P14_BAD"] = "nope";
    try {
      await post(app({ provider: "openai", baseURL: "${P14_BASE}" }), {});
      expect(seen[0]!.url).toBe("http://expanded.test/v1/chat/completions");
      expect(() => createProviderFromTarget({ name: "b", provider: "openai", apiKey: "k", baseURL: "${P14_BAD}" }))
        .toThrow(/not a valid http\(s\) URL after/);
    } finally {
      delete process.env["P14_BASE"];
      delete process.env["P14_BAD"];
    }
  });
});
