/** Contract: upstream failures as the openai SDK sees them (status, error shape, headers). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { baseConfig, postJson, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

let up: MockUpstream;
let gw: GatewayProcess;

beforeAll(async () => {
  up = startMockUpstream("secret-target-name");
  gw = await startGateway({ config: baseConfig([{ name: "secret-target-name", mock: up }], { requestTimeout: "2s" }) });
});
afterAll(async () => { await gw?.stop(); up?.stop(); });
beforeEach(() => up.reset());

const messages = [{ role: "user" as const, content: "hi" }];

async function sdkError(): Promise<InstanceType<typeof OpenAI.APIError>> {
  try {
    await gw.client().chat.completions.create({ model: "gpt-4o", messages });
  } catch (err) {
    if (err instanceof OpenAI.APIError) return err;
    throw err;
  }
  throw new Error("expected an APIError");
}

const UPSTREAM_400 = { status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens", type: "invalid_request_error", param: "messages", code: "context_length_exceeded" } } };

describe("errors", () => {
  it("upstream 400 keeps its HTTP status", async () => {
    up.enqueue(UPSTREAM_400);
    const err = await sdkError();
    expect(err.status).toBe(400);
  });

  // B3-7 (fixed in 2.1).
  it("upstream 400 error code/type/param reach the client unchanged", async () => {
    up.enqueue(UPSTREAM_400);
    const err = await sdkError();
    expect(err.code).toBe("context_length_exceeded");
    expect(err.type).toBe("invalid_request_error");
    expect(err.param).toBe("messages");
  });

  // B3-7 (fixed in 2.1): the target name is only in the X-Gateway-Target header.
  it("error body does not leak the target name or upstream URL", async () => {
    up.enqueue(UPSTREAM_400);
    const r = await postJson(gw, "/v1/chat/completions", { model: "gpt-4o", messages });
    const text = await r.text();
    expect(text).not.toContain("secret-target-name");
    expect(text).not.toContain(`127.0.0.1:${up.port}`);
    expect(r.headers.get("x-gateway-target")).toBe("secret-target-name");
  });

  it("network error body is generic (no URL, no Bun internals)", async () => {
    up.enqueue("rst");
    const r = await postJson(gw, "/v1/chat/completions", { model: "gpt-4o", messages });
    const text = await r.text();
    expect(r.status).toBe(502);
    expect(text).not.toContain("secret-target-name");
    expect(text).not.toContain(`127.0.0.1:${up.port}`);
    expect(text).toContain("upstream_unavailable");
  });

  // round-2 / B3-7 (fixed in 2.1).
  it("upstream 429 -> 429 with Retry-After", async () => {
    up.enqueue("429");
    const r = await postJson(gw, "/v1/chat/completions", { model: "gpt-4o", messages });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("7");
  });

  // round-2 (fixed in 2.1).
  it("upstream 500 -> 502", async () => {
    up.enqueue("500");
    const err = await sdkError();
    expect(err.status).toBe(502);
  });

  it("connection torn down mid-response -> 502", async () => {
    up.enqueue("rst");
    const err = await sdkError();
    expect(err.status).toBe(502);
  });

  // T3-12 (fixed in 2.1).
  it("garbage 200 body -> 502", async () => {
    up.enqueue("garbage_200");
    const err = await sdkError();
    expect(err.status).toBe(502);
  });

  it("upstream that never answers -> 504 after requestTimeout, upstream aborted", async () => {
    up.enqueue("hang");
    const t0 = Date.now();
    const err = await sdkError();
    expect(err.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(6000);
    await Bun.sleep(100);
    expect(up.requests[0]?.aborted).toBe(true);
  }, 15000);

  it("every error body is OpenAI-shaped { error: { message, type } }", async () => {
    for (const mode of [UPSTREAM_400, "500", "rst", "garbage_200"] as const) {
      up.enqueue(mode);
      const r = await postJson(gw, "/v1/chat/completions", { model: "gpt-4o", messages });
      const j = (await r.json()) as { error?: { message?: unknown; type?: unknown } };
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(typeof j.error?.message).toBe("string");
      expect(typeof j.error?.type).toBe("string");
    }
  });
});
