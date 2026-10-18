/** Contract: client auth on both entry points, and scope separation for /admin. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { ADMIN_SECRET, baseConfig, postJson, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

let up: MockUpstream;
let gw: GatewayProcess;
let cli: GatewayProcess;

const chat = { model: "gpt-4o", messages: [{ role: "user" as const, content: "hi" }] };

beforeAll(async () => {
  up = startMockUpstream("a");
  [gw, cli] = await Promise.all([
    startGateway({ config: baseConfig([{ name: "a", mock: up }]) }),
    startGateway({ config: baseConfig([{ name: "a", mock: up }]), entry: "cli" }),
  ]);
});
afterAll(async () => {
  await Promise.all([gw?.stop(), cli?.stop()]);
  up?.stop();
});

describe("auth", () => {
  for (const [name, get] of [
    ["src/index.ts serve", () => gw],
    ["ai-gateway serve (cli)", () => cli],
  ] as const) {
    it(`${name}: anonymous request -> 401, upstream never called`, async () => {
      const before = up.requests.length;
      const r = await postJson(get(), "/v1/chat/completions", chat, { auth: null });
      expect(r.status).toBe(401);
      expect(up.requests.length).toBe(before);
    });

    it(`${name}: wrong key -> 401 via the SDK`, async () => {
      const err = await get()
        .client({ apiKey: "sk-wrong" })
        .chat.completions.create(chat)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpenAI.AuthenticationError);
    });

    it(`${name}: configured client key -> 200`, async () => {
      const r = await get().client().chat.completions.create(chat);
      expect(r.choices[0]!.message.content).toBe("hello from a");
    });
  }

  it("an inference-scope key cannot use /admin (403)", async () => {
    const created = await gw.fetch("/admin/keys", {
      method: "POST",
      auth: null,
      headers: { "content-type": "application/json", "X-Admin-Secret": ADMIN_SECRET },
      body: JSON.stringify({ name: "e2e-client", scopes: ["inference"] }),
    });
    expect(created.status).toBeLessThan(300);
    const { key } = (await created.json()) as { key: string };
    expect(typeof key).toBe("string");

    const ok = await gw.client({ apiKey: key }).chat.completions.create(chat);
    expect(ok.choices).toHaveLength(1);

    const list = await gw.fetch("/admin/keys", { auth: key });
    expect(list.status).toBe(403);
    const mint = await gw.fetch("/admin/keys", {
      method: "POST",
      auth: key,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "escalate", scopes: ["admin"] }),
    });
    expect(mint.status).toBe(403);
  });
});
