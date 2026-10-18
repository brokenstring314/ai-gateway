// Regression N7 (was P-2): /v1/embeddings and /v1/images/generations call gateway.embed/generateImage directly,
// skipping every configured plugin (rate-limit, word-filter, budget). embedWithPlugins/generateImageWithPlugins are dead code.
import { describe, expect, it } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { cfg, mockProvider, newCalls } from "./_repro-helpers";

function setup(plugins: unknown[]) {
  const calls = newCalls();
  const c = cfg({ plugins } as never);
  const gw = new Gateway(c);
  gw.registerProvider(mockProvider(calls));
  return { app: createApp(gw, c), calls, gw };
}
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("P-2 plugins skipped on embeddings/images", () => {
  it("rate-limit (1 rpm) applies to /v1/images/generations", async () => {
    const { app } = setup([{ name: "rate-limit", config: { keyRpm: 1 } }]);
    const s: number[] = [];
    for (let i = 0; i < 3; i++)
      s.push((await post(app, "/v1/images/generations", { model: "gpt-4o", prompt: "cat" })).status);
    expect(s.filter((x) => x === 200).length).toBe(1); // actual: 3
  });
  it("rate-limit (1 rpm) applies to /v1/embeddings", async () => {
    const { app } = setup([{ name: "rate-limit", config: { keyRpm: 1 } }]);
    const s: number[] = [];
    for (let i = 0; i < 3; i++) s.push((await post(app, "/v1/embeddings", { model: "gpt-4o", input: "x" })).status);
    expect(s.filter((x) => x === 200).length).toBe(1); // actual: 3
  });
  it("word-filter (reject) blocks forbidden image prompt", async () => {
    const { app, calls } = setup([{ name: "word-filter", config: { blockedWords: ["forbidden"] } }]);
    const r = await post(app, "/v1/images/generations", { model: "gpt-4o", prompt: "a forbidden thing" });
    expect(r.status).toBe(403); // actual: 200
    expect(calls.image.length).toBe(0);
  });
  it("even embedWithPlugins ignores word-filter redact: original input sent upstream", async () => {
    const { gw, calls } = setup([{ name: "word-filter", config: { blockedWords: ["secret"], mode: "redact" } }]);
    await gw.embedWithPlugins({ metadata: {} }, { model: "gpt-4o", input: "my secret" });
    expect(JSON.stringify(calls.embed[0])).not.toContain("secret"); // actual: contains "my secret"
  });
  it("embedWithPlugins redacts each item of array input and keeps array shape", async () => {
    const { gw, calls } = setup([{ name: "word-filter", config: { blockedWords: ["secret"], mode: "redact" } }]);
    await gw.embedWithPlugins({ metadata: {} }, { model: "gpt-4o", input: ["a secret", "plain"] });
    expect((calls.embed[0] as { input: unknown }).input).toEqual(["a ***", "plain"]);
  });
  it("image prompt is redacted before reaching upstream", async () => {
    const { app, calls } = setup([{ name: "word-filter", config: { blockedWords: ["secret"], mode: "redact" } }]);
    const r = await post(app, "/v1/images/generations", { model: "gpt-4o", prompt: "draw my secret" });
    expect(r.status).toBe(200);
    expect((calls.image[0] as { prompt: string }).prompt).toBe("draw my ***");
  });
  it("short-circuit skips upstream: supplied embedding response returned, otherwise rejected", async () => {
    const { gw, calls } = setup([]);
    const canned = {
      object: "list",
      model: "gpt-4o",
      provider: "plugin",
      data: [{ object: "embedding", index: 0, embedding: [9] }],
      usage: { promptTokens: 0, totalTokens: 0 },
    };
    gw.registerPlugin("before_request", {
      name: "sc",
      stage: "before_request",
      execute: async (ctx) => {
        if (ctx.request.messages[0]?.content === "canned") ctx.metadata["_embeddingResponse"] = canned;
        return { action: "short_circuit", response: {} as never };
      },
    });
    expect(await gw.embedWithPlugins({ metadata: {} }, { model: "gpt-4o", input: "canned" })).toBe(canned as never);
    await expect(gw.embedWithPlugins({ metadata: {} }, { model: "gpt-4o", input: "other" })).rejects.toThrow(
      /short-circuited/,
    );
    await expect(gw.generateImageWithPlugins({ metadata: {} }, { model: "gpt-4o", prompt: "x" })).rejects.toThrow(
      /short-circuited/,
    );
    expect(calls.embed.length).toBe(0);
    expect(calls.image.length).toBe(0);
  });
});
