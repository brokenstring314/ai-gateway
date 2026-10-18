/**
 * Unit tests for ConditionalStrategy.
 */

import { describe, it, expect } from "bun:test";
import { createMockProvider, createStreamMockProvider, createReq } from "./helpers";
import { boundConditional } from "./helpers";

describe("ConditionalStrategy", () => {
  it("routes by model field match", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = boundConditional(lookup, {
      rules: [
        { field: "model", pattern: "gpt-", target: "openai" },
        { field: "model", pattern: "llama", target: "groq" },
      ],
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({ model: "gpt-4" }),
    );
    expect(resp.provider).toBe("openai");
  });

  it("routes by user field match", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = boundConditional(lookup, {
      rules: [
        { field: "user", pattern: "premium", target: "openai" },
        { field: "user", pattern: "free", target: "groq" },
      ],
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({ user: "premium-123" }),
    );
    expect(resp.provider).toBe("openai");
  });

  it("routes by first message content", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = boundConditional(lookup, {
      rules: [
        { field: "message", pattern: "code", target: "openai" },
        { field: "message", pattern: "chat", target: "groq" },
      ],
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({
        messages: [{ role: "user", content: "write some code for me" }],
      }),
    );
    expect(resp.provider).toBe("openai");
  });

  it("uses defaultTarget when no rule matches", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = boundConditional(lookup, {
      rules: [{ field: "model", pattern: "gpt-5", target: "openai" }],
      defaultTarget: "groq",
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({ model: "gpt-4" }),
    );
    expect(resp.provider).toBe("groq");
  });

  it("throws when no rule matches and no defaultTarget", async () => {
    const openai = createMockProvider("openai");
    const lookup = (name: string) => (name === "openai" ? openai : undefined);

    const strategy = boundConditional(lookup, {
      rules: [{ field: "model", pattern: "gpt-5", target: "openai" }],
    });

    await expect(
      strategy.execute({ metadata: {} }, createReq({ model: "gpt-4" })),
    ).rejects.toThrow("no rule matched");
  });

  it("streams to the matched target", async () => {
    const openai = createStreamMockProvider("openai");
    const groq = createStreamMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = boundConditional(lookup, {
      rules: [{ field: "model", pattern: "gpt-", target: "openai" }],
    });

    const chunks: unknown[] = [];
    for await (const chunk of strategy.executeStream(
      { metadata: {} },
      createReq({ model: "gpt-4" }),
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
  });

  it("handles regex patterns correctly", async () => {
    const openai = createMockProvider("openai");
    const lookup = (name: string) => name === "openai" ? openai : undefined;

    const strategy = boundConditional(lookup, {
      rules: [{ field: "model", pattern: "^gpt-4(o|-turbo)", target: "openai" }],
      defaultTarget: "openai",
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({ model: "gpt-4o" }),
    );
    expect(resp.provider).toBe("openai");

    const resp2 = await strategy.execute(
      { metadata: {} },
      createReq({ model: "gpt-3.5" }),
    );
    expect(resp2.provider).toBe("openai");
  });

  it("matches first rule that matches", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = boundConditional(lookup, {
      rules: [
        { field: "model", pattern: "gpt-", target: "openai" },
        { field: "model", pattern: "gpt-4", target: "groq" },
      ],
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({ model: "gpt-4" }),
    );
    expect(resp.provider).toBe("openai");
  });

  it("selectTargets is the execution order: matched target, then the default (other rules' targets serve other content)", () => {
    const lookup = (name: string) => createMockProvider(name);
    const strategy = boundConditional(lookup, {
      rules: [
        { field: "model", pattern: "gpt-", target: "openai" },
        { field: "model", pattern: "llama", target: "groq" },
      ],
      defaultTarget: "deepseek",
    });

    const targets = strategy.selectTargets(createReq({ model: "gpt-4" }));
    expect(targets).toEqual(["openai", "deepseek"]);
  });

  it("invalid regex pattern throws at construction (startup), not per request", () => {
    const openai = createMockProvider("openai");
    const lookup = (name: string) => name === "openai" ? openai : undefined;
    expect(() => boundConditional(lookup, {
      rules: [{ field: "model", pattern: "[invalid", target: "openai" }],
      defaultTarget: "openai",
    })).toThrow(/invalid pattern/);
  });

  it("field prompt + contains matches any user message case-insensitively (absorbs content_based)", () => {
    const strategy = boundConditional(() => undefined, {
      rules: [{ field: "prompt", contains: "Code", target: "coder" }],
      defaultTarget: "general",
    });
    expect(strategy.selectTargets(createReq({
      messages: [
        { role: "system", content: "you write code" },
        { role: "user", content: "hello" },
        { role: "user", content: [{ type: "text", text: "fix my CODE" }] as never },
      ],
    }))[0]).toBe("coder");
    expect(strategy.selectTargets(createReq({
      messages: [{ role: "system", content: "code" }, { role: "user", content: "hello" }],
    }))[0]).toBe("general");
  });

  it("field prompt + pattern uses a regex", () => {
    const strategy = boundConditional(() => undefined, {
      rules: [{ field: "prompt", pattern: "^\\[code\\]", target: "coder" }],
      defaultTarget: "general",
    });
    expect(strategy.selectTargets(createReq({ messages: [{ role: "user", content: "[code] fix" }] }))[0]).toBe("coder");
    expect(strategy.selectTargets(createReq({ messages: [{ role: "user", content: "x [code]" }] }))[0]).toBe("general");
  });
});
