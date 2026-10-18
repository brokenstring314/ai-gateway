/** Contract: the pii-secret-guard plugin as the official openai SDK sees it (real process, real config file). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { baseConfig, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

// Credential-shaped fixture assembled at runtime (no literal token in the repo).
const GHP = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const EMAIL = "e2e.person@example.org";
const PHONE = "+86 138 1234 5678";

let up: MockUpstream;
let gw: GatewayProcess;

beforeAll(async () => {
  up = startMockUpstream("a");
  gw = await startGateway({
    config: baseConfig([{ name: "a", mock: up }], {
      plugins: [
        {
          name: "pii-secret-guard",
          stage: "before_request",
          type: "guardrail",
          config: { categories: { secret: "block", pii: "redact" }, roles: ["user", "system", "tool"] },
        },
      ],
    }),
  });
});
afterAll(async () => {
  await gw?.stop();
  up?.stop();
});
beforeEach(() => up.reset());

describe("pii-secret-guard (openai SDK)", () => {
  it("secret in the prompt: APIError 400 secret_detected, nothing upstream, value never echoed or logged", async () => {
    let err: InstanceType<typeof OpenAI.APIError> | undefined;
    try {
      await gw.client().chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: `deploy with ${GHP}` }],
      });
    } catch (e) {
      if (e instanceof OpenAI.APIError) err = e;
      else throw e;
    }
    expect(err?.status).toBe(400);
    expect(err?.code).toBe("secret_detected");
    expect(err?.type).toBe("invalid_request_error");
    expect(err?.message).toContain("github_token");
    expect(err?.message).not.toContain(GHP);
    expect(up.requests).toHaveLength(0);
    await Bun.sleep(100);
    expect(gw.logs()).toContain('"entities":["github_token"]');
    expect(gw.logs()).not.toContain(GHP);
  });

  it("PII in the prompt and content parts: redacted before it reaches the upstream", async () => {
    const r = await gw.client().chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: `email ${EMAIL}, phone ${PHONE}` }] },
      ],
    });
    expect(r.choices[0]!.message.content).toBe("hello from a");
    expect(up.requests).toHaveLength(1);
    const sent = JSON.stringify(up.requests[0]!.body.messages);
    expect(sent).toContain("email [EMAIL], phone [PHONE]");
    expect(sent).not.toContain(EMAIL);
    await Bun.sleep(100);
    expect(gw.logs()).toContain('"action":"redacted","entities":["email","phone"]');
    expect(gw.logs()).not.toContain(EMAIL);
  });

  it("embeddings input is redacted", async () => {
    await gw.client().embeddings.create({ model: "text-embedding-3-small", input: `who is ${EMAIL}?` });
    expect(up.requests[0]!.body.input).toEqual("who is [EMAIL]?");
  });
});
