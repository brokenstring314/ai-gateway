/** Contract: fallback routing across two targets, for chat, embeddings and images. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { baseConfig, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

let a: MockUpstream;
let b: MockUpstream;
let gw: GatewayProcess;

async function start() {
  return startGateway({
    config: baseConfig([
      { name: "a", mock: a, extra: { circuitBreaker: { failureThreshold: 3, successThreshold: 1, timeoutMs: 60_000 } } },
      { name: "b", mock: b },
    ]),
  });
}

beforeAll(async () => {
  a = startMockUpstream("a");
  b = startMockUpstream("b");
  gw = await start();
});
afterAll(async () => { await gw?.stop(); a?.stop(); b?.stop(); });
beforeEach(() => { a.reset(); b.reset(); });

const messages = [{ role: "user" as const, content: "hi" }];

describe("routing (fallback a -> b)", () => {
  it("primary 500 -> served by backup", async () => {
    a.enqueue("500");
    const r = await gw.client().chat.completions.create({ model: "gpt-4o", messages });
    expect(r.choices[0]!.message.content).toBe("hello from b");
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });

  it("primary 401 (revoked upstream key) -> served by backup", async () => {
    a.enqueue("401");
    const r = await gw.client().chat.completions.create({ model: "gpt-4o", messages });
    expect(r.choices[0]!.message.content).toBe("hello from b");
  });

  it("streaming: primary 500 before the first chunk -> backup stream", async () => {
    a.enqueue("500");
    const s = await gw.client().chat.completions.create({ model: "gpt-4o", messages, stream: true });
    let text = "";
    for await (const ch of s) text += ch.choices[0]?.delta?.content ?? "";
    expect(text).toBe("Hello");
    expect(b.requests).toHaveLength(1);
  });

  it("embeddings fail over", async () => {
    a.enqueue("500");
    const r = await gw.client().embeddings.create({ model: "text-embedding-3-small", input: ["x", "y"] });
    expect(r.data).toHaveLength(2);
    expect(b.requests.some((q) => q.path.endsWith("/embeddings"))).toBe(true);
  });

  it("image generation fails over", async () => {
    a.enqueue("500");
    const r = await gw.client().images.generate({ model: "dall-e-3", prompt: "cat" });
    expect(r.data?.[0]?.url).toBe("https://img.example/b.png");
  });

  it("open breaker on the primary: traffic goes to the backup and /readyz stays 200", async () => {
    // Fresh process so earlier failures do not decide the breaker state.
    await gw.stop();
    gw = await start();
    a.setDefault("500");
    for (let i = 0; i < 3; i++) await gw.client().chat.completions.create({ model: "gpt-4o", messages });
    const before = a.requests.length;
    const r = await gw.client().chat.completions.create({ model: "gpt-4o", messages });
    expect(r.choices[0]!.message.content).toBe("hello from b");
    expect(a.requests.length).toBe(before); // breaker open: primary not tried
    const ready = await gw.fetch("/readyz", { auth: null });
    expect(ready.status).toBe(200);
    const body = (await ready.json()) as { circuitBreakers?: Record<string, string> };
    expect(String(body.circuitBreakers?.["a"]).toLowerCase()).toContain("open");
  });
});
