/**
 * Unit tests for SingleStrategy.
 */

import { describe, it, expect } from "bun:test";
import { createMockProvider, createStreamMockProvider, createReq } from "./helpers";
import { boundSingle } from "./helpers";

describe("SingleStrategy", () => {
  it("selects the configured target", () => {
    const provider = createMockProvider("openai");
    const lookup = (name: string) => (name === "openai" ? provider : undefined);
    const strategy = boundSingle(lookup, { target: "openai" });

    const targets = strategy.selectTargets(createReq());
    expect(targets).toEqual(["openai"]);
  });

  it("routes execute() to the target provider", async () => {
    const provider = createMockProvider("openai");
    const lookup = (name: string) => (name === "openai" ? provider : undefined);
    const strategy = boundSingle(lookup, { target: "openai" });

    const req = createReq({ model: "gpt-4" });
    const resp = await strategy.execute({ metadata: {} }, req);

    expect(resp.provider).toBe("openai");
    expect(resp.model).toBe("gpt-4");
    expect(resp.choices[0]!.message!.content).toBe("Hello from openai");
  });

  it("routes executeStream() to the target provider", async () => {
    const provider = createStreamMockProvider("openai");
    const lookup = (name: string) => (name === "openai" ? provider : undefined);
    const strategy = boundSingle(lookup, { target: "openai" });

    const req = createReq({ model: "gpt-4" });
    const chunks: unknown[] = [];
    for await (const chunk of strategy.executeStream({ metadata: {} }, req)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { model: string }).model).toBe("gpt-4");
  });

  it("throws when provider not found", async () => {
    const strategy = boundSingle(() => undefined, { target: "missing" });

    await expect(strategy.execute({ metadata: {} }, createReq())).rejects.toThrow("not found");
  });

  it("throws on stream when provider does not support streaming", async () => {
    const provider = createMockProvider("openai");
    const lookup = (name: string) => (name === "openai" ? provider : undefined);
    const strategy = boundSingle(lookup, { target: "openai" });

    const iter = strategy.executeStream({ metadata: {} }, createReq());
    await expect(
      (async () => {
        for await (const _ of iter) {
          /* consume */
        }
      })(),
    ).rejects.toThrow("does not support streaming");
  });
});
