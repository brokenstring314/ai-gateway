import { describe, it, expect } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { createOpenAICompatProvider } from "@/providers/openai-compat";
import type { GatewayConfig } from "@/config/types";
import type { RequestContext, ChatCompletionRequest, StreamChunk } from "@/providers/types";

// Regression: H10 — client disconnect must cancel the upstream stream, and a
// client abort must surface as AbortError (not ProviderError(0)).

const cfg = {
  strategy: { mode: "single", targets: ["mock"] },
  targets: [{ name: "mock", provider: "openai", apiKey: "sk", baseURL: "https://up.example/v1", models: ["gpt-4o"] }],
} as GatewayConfig;

function slowStreamProvider(state: { aborted: boolean; produced: number; done: boolean }) {
  return {
    name: "mock",
    async complete() { throw new Error("n/a"); },
    async *completeStream(ctx: RequestContext, req: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
      ctx.signal?.addEventListener("abort", () => { state.aborted = true; });
      try {
        for (let i = 0; i < 20; i++) {
          state.produced++;
          yield { id: "x", object: "chat.completion.chunk", created: 1, model: req.model,
            choices: [{ index: 0, delta: { content: "t" }, finishReason: null }] } as unknown as StreamChunk;
          await Bun.sleep(20);
        }
      } finally { state.done = true; }
    },
    supportedModels: () => ["gpt-4o"], supportsModel: () => true, models: () => [{ id: "gpt-4o", ownedBy: "mock" }],
  };
}

describe("chat streaming client disconnect", () => {
  it("cancelling the SSE body aborts and stops the upstream stream", async () => {
    const st = { aborted: false, produced: 0, done: false };
    const gw = new Gateway(cfg);
    gw.registerProvider(slowStreamProvider(st) as never);
    const app = createApp(gw, cfg);
    const body = JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
    const r = await app.request("/v1/chat/completions", { method: "POST", body });
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(150);
    expect(st.produced).toBeLessThan(5);
    expect(st.aborted).toBe(true);
    expect(st.done).toBe(true);
  });
});

describe("provider abort propagation", () => {
  it("client abort surfaces as AbortError, not ProviderError(statusCode 0)", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(2000); return new Response("{}"); } });
    try {
      const p = createOpenAICompatProvider({ name: "p", baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "k" });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20);
      const err = await p.complete({ signal: ac.signal } as any, { model: "m", messages: [{ role: "user", content: "x" }] }).then(() => null, (e) => e);
      expect(err?.name).toBe("AbortError");
    } finally {
      server.stop(true);
    }
  });
});
