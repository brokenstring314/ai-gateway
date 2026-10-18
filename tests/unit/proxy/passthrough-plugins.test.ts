// Regression (N8): the /v1/* catch-all pass-through proxy bypassed every
// plugin, breaker and fallback — including for trivially re-spelled real
// routes (/v1/chat/completions/, //, case variants) and for /v1/responses.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { normalizeRoutePath } from "@/server/route-path";
import { cfg, mockProvider, newCalls } from "../plugins/_repro-helpers";

let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    new Response(JSON.stringify({ id: "resp_1", object: "response" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
});
afterEach(() => fetchSpy.mockRestore());

function setup(plugins: unknown[], passthrough?: boolean) {
  const calls = newCalls();
  const c = cfg({ plugins, auth: { enabled: false }, ...(passthrough === undefined ? {} : { passthroughProxy: { enabled: passthrough } }) } as never);
  const gw = new Gateway(c);
  gw.registerProvider(mockProvider(calls));
  return { app: createApp(gw, c), calls };
}
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const forbidden = { model: "gpt-4o", messages: [{ role: "user", content: "forbidden words" }] };
const variants = ["/v1/chat/completions/", "/v1//chat/completions", "/v1/chat/Completions", "/V1/CHAT/COMPLETIONS", "/v1/chat%2Fcompletions", "//v1/chat/completions//"];

describe("N8 route normalization", () => {
  it("normalizeRoutePath maps spellings of gateway routes onto the real route", () => {
    for (const v of variants) expect(normalizeRoutePath(v)).toBe("/v1/chat/completions");
    expect(normalizeRoutePath("/v1/embeddings/")).toBe("/v1/embeddings");
    expect(normalizeRoutePath("/v1/responses/")).toBe("/v1/responses");
    expect(normalizeRoutePath("/")).toBe("/");
  });

  for (const path of variants) {
    it(`${path} reaches the chat handler (word-filter applies, nothing proxied)`, async () => {
      const { app, calls } = setup([{ name: "word-filter", config: { blockedWords: ["forbidden"] } }], true);
      const r = await post(app, path, forbidden);
      expect(r.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
      const ok = await post(app, path, { model: "gpt-4o", messages: [{ role: "user", content: "fine" }] });
      expect(ok.status).toBe(200);
      expect(calls.chat.length).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});

describe("N8 pass-through proxy", () => {
  it("is disabled by default: unknown /v1 routes are 404 and never forwarded", async () => {
    const { app } = setup([]);
    const r = await post(app, "/v1/responses", { model: "gpt-4o", input: "hi" });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("unknown_route");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when enabled, word-filter blocks /v1/responses input before forwarding", async () => {
    const { app } = setup([{ name: "word-filter", config: { blockedWords: ["forbidden"] } }], true);
    expect((await post(app, "/v1/responses", { model: "gpt-4o", input: "forbidden words" })).status).toBe(403);
    expect((await post(app, "/v1/responses", { model: "gpt-4o", input: [{ role: "user", content: [{ type: "input_text", text: "forbidden" }] }] })).status).toBe(403);
    expect((await post(app, "/v1/responses", { model: "gpt-4o", instructions: "forbidden", input: "ok" })).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    const ok = await post(app, "/v1/responses", { model: "gpt-4o", input: "hello" });
    expect(ok.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("when enabled, word-filter redact cannot be applied to an unknown body, so it rejects", async () => {
    const { app } = setup([{ name: "word-filter", config: { blockedWords: ["secret"], mode: "redact" } }], true);
    expect((await post(app, "/v1/responses", { model: "gpt-4o", input: "my secret" })).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when enabled, key-scoped rate limit applies, including to non-JSON bodies", async () => {
    const { app } = setup([{ name: "rate-limit", config: { keyRpm: 1 } }], true);
    const s: number[] = [];
    for (let i = 0; i < 3; i++) s.push((await post(app, "/v1/files", "not json", { "X-Provider": "openai" })).status);
    expect(s).toEqual([200, 429, 429]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
