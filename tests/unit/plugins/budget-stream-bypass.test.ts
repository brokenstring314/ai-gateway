// Regression (N6): streaming requests must run after-request plugins (budget),
// the request log and metrics exactly once — including when the client aborts
// mid-stream or the upstream sends no usage chunk.
import { beforeEach, describe, expect, it } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { resetBudgetStore } from "@/plugins/builtins/budget";
import type { IPlugin, PluginContext } from "@/plugins/types";
import type { ChatCompletionRequest, IProvider, RequestContext, StreamChunk } from "@/providers/types";
import { cfg, mockProvider, newCalls } from "./_repro-helpers";

const budget = [
  { name: "budget", stage: "before_request", config: { dailyBudget: 1, costPer1kInput: 0.5, costPer1kOutput: 0.5 } },
];

function streamBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: "gpt-4o",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "budget-stream-" + Math.random() }],
    ...extra,
  });
}

describe("N6 streaming runs after-request plugins / logs / metrics", () => {
  beforeEach(() => resetBudgetStore());

  it("rejects once dailyBudget is spent, even when the spend came from streams", async () => {
    const calls = newCalls();
    // each response costs 1*0.5 + 1*0.5 = $1; budget $1 → 2nd request must be rejected
    const c = cfg({ plugins: budget } as never);
    const gw = new Gateway(c);
    gw.registerProvider(mockProvider(calls));
    const app = createApp(gw, c);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: streamBody(),
      });
      await r.text();
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 429, 429, 429, 429]);
  });

  it("control: same budget rejects the 2nd non-stream request", async () => {
    const calls = newCalls();
    const c = cfg({ plugins: budget } as never);
    const gw = new Gateway(c);
    gw.registerProvider(mockProvider(calls));
    const app = createApp(gw, c);
    const s: number[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ns-" + Math.random() }] }),
      });
      s.push(r.status);
    }
    expect(s).toEqual([200, 429]);
  });

  function countingGateway(provider: IProvider) {
    const c = cfg();
    const gw = new Gateway(c);
    gw.registerProvider(provider);
    const seen: PluginContext[] = [];
    const after: IPlugin = {
      name: "spy",
      stage: "after_request",
      execute: async (ctx) => {
        seen.push(ctx);
        return { action: "continue" };
      },
    };
    gw.registerPlugin("after_request", after);
    return { gw, seen };
  }

  const req = (): ChatCompletionRequest => ({
    model: "gpt-4o",
    stream: true,
    messages: [{ role: "user", content: "x".repeat(400) }],
  });
  const rctx = (): RequestContext => ({ metadata: {} });

  it("after-plugins run exactly once with the usage chunk's usage", async () => {
    const provider = {
      ...mockProvider(newCalls()),
      async *completeStream(_c: RequestContext, r: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
        yield {
          id: "s1",
          object: "chat.completion.chunk",
          created: 1,
          model: r.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "he" }, finishReason: "" }],
        };
        yield {
          id: "s1",
          object: "chat.completion.chunk",
          created: 1,
          model: r.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "llo" }, finishReason: "stop" }],
        };
        yield {
          id: "s1",
          object: "chat.completion.chunk",
          created: 1,
          model: r.model,
          choices: [],
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        };
      },
    } as unknown as IProvider;
    const { gw, seen } = countingGateway(provider);
    for await (const _ of gw.routeStream(rctx(), req())) {
      /* drain */
    }
    expect(seen.length).toBe(1);
    expect(seen[0]!.response?.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(seen[0]!.response?.choices[0]?.message?.content).toBe("hello");
    expect(seen[0]!.response?.provider).toBe("mock");
  });

  it("client abort mid-stream still runs after-plugins once (estimated usage)", async () => {
    const provider = {
      ...mockProvider(newCalls()),
      async *completeStream(_c: RequestContext, r: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
        for (let i = 0; i < 100; i++) {
          yield {
            id: "s2",
            object: "chat.completion.chunk",
            created: 1,
            model: r.model,
            choices: [{ index: 0, delta: { role: "assistant", content: "abcd" }, finishReason: "" }],
          };
        }
      },
    } as unknown as IProvider;
    const { gw, seen } = countingGateway(provider);
    let n = 0;
    for await (const _ of gw.routeStream(rctx(), req())) {
      if (++n === 3) break;
    }
    expect(seen.length).toBe(1);
    const u = seen[0]!.response!.usage;
    expect(u.promptTokens).toBe(100); // 400 chars / 4
    expect(u.completionTokens).toBe(3); // 12 chars / 4
  });

  it("mid-stream upstream error runs on-error + after plugins once and rethrows", async () => {
    const provider = {
      ...mockProvider(newCalls()),
      async *completeStream(_c: RequestContext, r: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
        yield {
          id: "s3",
          object: "chat.completion.chunk",
          created: 1,
          model: r.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "abcd" }, finishReason: "" }],
        };
        throw new Error("boom");
      },
    } as unknown as IProvider;
    const { gw, seen } = countingGateway(provider);
    let errs = 0;
    gw.registerPlugin("on_error", {
      name: "e",
      stage: "on_error",
      execute: async () => {
        errs++;
        return { action: "continue" };
      },
    });
    await expect(
      (async () => {
        for await (const _ of gw.routeStream(rctx(), req())) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("boom");
    expect(errs).toBe(1);
    expect(seen.length).toBe(1);
  });

  it("streams are counted in metrics and the request log", async () => {
    const { getMetrics } = await import("@/metrics/metrics");
    getMetrics().reset();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      const { gw } = countingGateway(mockProvider(newCalls()));
      const ctx: RequestContext = { traceId: "trace-n6-" + Math.random(), metadata: {} };
      for await (const _ of gw.routeStream(ctx, req())) {
        /* drain */
      }
      const entry = lines
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((e) => e?.["requestId"] === ctx.traceId);
      expect(entry).toBeDefined();
      expect(entry!["provider"]).toBe("mock");
      expect((entry!["tokens"] as Record<string, number>)["total"]).toBe(2000);
    } finally {
      console.log = orig;
    }
    const text = await getMetrics().format();
    expect(text).toContain(`ai_gateway_tokens_input_total{provider="mock",model="gpt-4o"} 1000`);
    expect(text).toContain(`ai_gateway_tokens_output_total{provider="mock",model="gpt-4o"} 1000`);
  });
});
