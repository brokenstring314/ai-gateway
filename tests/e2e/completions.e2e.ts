/** Contract: legacy /v1/completions as the openai SDK sees it. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { baseConfig, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

let up: MockUpstream;
let gw: GatewayProcess;

beforeAll(async () => {
  up = startMockUpstream("a");
  gw = await startGateway({ config: baseConfig([{ name: "a", mock: up }]) });
});
afterAll(async () => {
  await gw?.stop();
  up?.stop();
});
beforeEach(() => up.reset());

// T3-7 (fixed in 2.6): text_completion shape, snake_case params forwarded.
describe("completions", () => {
  it("returns 200 with the upstream content", async () => {
    const r = await gw.fetch("/v1/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-3.5-turbo-instruct", prompt: "hi" }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/from a/);
  });

  it("choices[0].text and object: text_completion", async () => {
    const r = await gw.client().completions.create({ model: "gpt-3.5-turbo-instruct", prompt: "hi" });
    expect(r.object).toBe("text_completion");
    expect(r.choices[0]!.text).toMatch(/from a/);
    expect(r.choices[0]!.finish_reason).toBe("stop");
    expect(r.usage?.prompt_tokens).toBeGreaterThan(0);
  });

  it("max_tokens / top_p reach the upstream", async () => {
    await gw.client().completions.create({ model: "gpt-3.5-turbo-instruct", prompt: "hi", max_tokens: 5, top_p: 0.5 });
    expect(up.requests[0]?.body?.max_tokens).toBe(5);
    expect(up.requests[0]?.body?.top_p).toBe(0.5);
  });

  it("stream chunks carry choices[].text", async () => {
    const s = await gw.client().completions.create({ model: "gpt-3.5-turbo-instruct", prompt: "hi", stream: true });
    let text = "";
    for await (const ch of s) text += ch.choices[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
  });
});
