/**
 * Unit tests for ContentBasedStrategy.
 */

import { describe, it, expect } from "vitest";
import { ContentBasedStrategy } from "@/routing/content-based";
import { createMockProvider, createStreamMockProvider, createReq } from "./helpers";

describe("ContentBasedStrategy", () => {
  it("routes to target matching keyword in message", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = new ContentBasedStrategy(lookup, {
      keywords: [
        { keyword: "code", target: "openai" },
        { keyword: "chat", target: "groq" },
      ],
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({
        messages: [{ role: "user", content: "help me write code" }],
      }),
    );
    expect(resp.provider).toBe("openai");
  });

  it("case-insensitive keyword matching", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = new ContentBasedStrategy(lookup, {
      keywords: [{ keyword: "OpenAI", target: "openai" }],
      defaultTarget: "groq",
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({
        messages: [{ role: "user", content: "use openai model" }],
      }),
    );
    expect(resp.provider).toBe("openai");
  });

  it("uses defaultTarget when no keyword matches", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = new ContentBasedStrategy(lookup, {
      keywords: [{ keyword: "math", target: "openai" }],
      defaultTarget: "groq",
    });

    const resp = await strategy.execute(
      { metadata: {} },
      createReq({
        messages: [{ role: "user", content: "hello world" }],
      }),
    );
    expect(resp.provider).toBe("groq");
  });

  it("throws when no keyword matches and no defaultTarget", async () => {
    const openai = createMockProvider("openai");
    const lookup = (name: string) => (name === "openai" ? openai : undefined);

    const strategy = new ContentBasedStrategy(lookup, {
      keywords: [{ keyword: "math", target: "openai" }],
    });

    await expect(
      strategy.execute(
        { metadata: {} },
        createReq({
          messages: [{ role: "user", content: "hello" }],
        }),
      ),
    ).rejects.toThrow("no keyword matched");
  });

  it("last defined keyword takes priority", async () => {
    const openai = createMockProvider("openai");
    const groq = createMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = new ContentBasedStrategy(lookup, {
      keywords: [
        { keyword: "ai", target: "openai" },
        { keyword: "help", target: "groq" },
      ],
    });

    // "ai help me" matches both; last defined keyword ("help") wins
    const resp = await strategy.execute(
      { metadata: {} },
      createReq({
        messages: [{ role: "user", content: "ai help me" }],
      }),
    );
    expect(resp.provider).toBe("groq");
  });

  it("streams to the matched target", async () => {
    const openai = createStreamMockProvider("openai");
    const groq = createStreamMockProvider("groq");
    const lookup = (name: string) =>
      name === "openai" ? openai : name === "groq" ? groq : undefined;

    const strategy = new ContentBasedStrategy(lookup, {
      keywords: [{ keyword: "code", target: "openai" }],
    });

    const chunks: unknown[] = [];
    for await (const chunk of strategy.executeStream(
      { metadata: {} },
      createReq({
        messages: [{ role: "user", content: "write code" }],
      }),
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
  });
});
