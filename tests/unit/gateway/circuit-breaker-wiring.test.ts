import { describe, it, expect } from "bun:test";
import { Gateway } from "@/gateway";
import type { GatewayConfig } from "@/config/types";
import type { IProvider, StreamChunk } from "@/providers/types";

// Regression: H11 (open breaker never blocked) and H12 (outcome recorded on
// re-selected targets instead of the target actually invoked).

const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
const resp = (p: string) => ({
  id: "x",
  object: "chat.completion",
  created: 0,
  model: "m",
  provider: p,
  choices: [{ index: 0, message: { role: "assistant" as const, content: "ok" }, finishReason: "stop" }],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
});
const chunk = (c: string): StreamChunk => ({
  id: "1",
  object: "chat.completion.chunk",
  created: 0,
  model: "m",
  choices: [{ index: 0, delta: { role: "assistant", content: c }, finishReason: "" }],
});
function prov(
  name: string,
  complete: () => Promise<any>,
  stream?: () => AsyncGenerator<StreamChunk>,
): IProvider & { calls: number } {
  const p: any = { name, calls: 0, supportedModels: () => [], supportsModel: () => true, models: () => [] };
  p.complete = async () => {
    p.calls++;
    return complete();
  };
  if (stream)
    p.completeStream = () => {
      p.calls++;
      return stream();
    };
  return p;
}
const tgt = (name: string, extra: any = {}) => ({
  name,
  provider: "openai",
  apiKey: "k",
  baseURL: "http://127.0.0.1:1/v1",
  ...extra,
});
const cb = { circuitBreaker: { failureThreshold: 1, timeoutMs: 60000 } };

describe("gateway circuit breaker wiring", () => {
  it("open breaker blocks calls to that target (503)", async () => {
    const g = new Gateway({
      strategy: { mode: "single", targets: ["a"] },
      targets: [tgt("a", cb)],
    } as any as GatewayConfig);
    const a = prov("a", async () => {
      throw new Error("down");
    });
    g.registerProvider(a);
    await g.route({} as any, req).catch(() => {});
    expect(g.getCircuitBreakerRegistry().get("a")!.getState()).toBe("OPEN");
    const status = await g.route({} as any, req).then(
      () => 0,
      (e) => e.statusCode,
    );
    expect(a.calls).toBe(1);
    expect(status).toBe(503);
  });

  it("fallback skips an open target and records outcomes per invoked target", async () => {
    const g = new Gateway({
      strategy: { mode: "fallback", targets: ["a", "b"] },
      targets: [tgt("a", cb), tgt("b", cb)],
    } as any as GatewayConfig);
    const a = prov("a", async () => {
      throw new Error("down");
    });
    const b = prov("b", async () => resp("b"));
    g.registerProvider(a);
    g.registerProvider(b);
    expect((await g.route({} as any, req)).provider).toBe("b");
    expect(g.getCircuitBreakerRegistry().get("a")!.getState()).toBe("OPEN");
    expect(g.getCircuitBreakerRegistry().get("b")!.getState()).toBe("CLOSED");
    expect((await g.route({} as any, req)).provider).toBe("b");
    expect(a.calls).toBe(1); // second request did not hit the open target
  });

  it("failure is not recorded on unrelated, uninvoked targets", async () => {
    const g = new Gateway({
      strategy: { mode: "conditional", targets: ["a"], rules: [{ field: "model", pattern: "^zzz$", target: "b" }] },
      targets: [tgt("a"), tgt("b", cb)],
    } as any as GatewayConfig);
    g.registerProvider(
      prov("a", async () => {
        throw new Error("down");
      }),
    );
    g.registerProvider(prov("b", async () => resp("b")));
    await g.route({} as any, req).catch(() => {});
    expect(g.getCircuitBreakerRegistry().get("b")!.getState()).toBe("CLOSED");
  });

  it("loadbalance records failure only on the randomly picked target", async () => {
    const g = new Gateway({
      strategy: { mode: "loadbalance", targets: ["a", "b"] },
      targets: [tgt("a", cb), tgt("b", cb)],
    } as any as GatewayConfig);
    const a = prov("a", async () => {
      throw new Error("down");
    });
    const b = prov("b", async () => resp("b"));
    g.registerProvider(a);
    g.registerProvider(b);
    for (let i = 0; i < 20; i++) await g.route({} as any, req).catch(() => {});
    expect(b.calls).toBeGreaterThan(0);
    expect(a.calls).toBe(1); // tripped on first failure, then blocked
    expect(g.getCircuitBreakerRegistry().get("b")!.getState()).toBe("CLOSED");
  });

  it("streaming: open breaker blocks; client abort is not counted as failure", async () => {
    const g = new Gateway({
      strategy: { mode: "single", targets: ["a"] },
      targets: [tgt("a", cb)],
    } as any as GatewayConfig);
    let mode: "abort" | "fail" = "abort";
    const a = prov(
      "a",
      async () => resp("a"),
      async function* () {
        if (mode === "abort") throw new DOMException("Aborted", "AbortError");
        yield chunk("x");
        throw new Error("mid-stream");
      },
    );
    g.registerProvider(a);
    const drain = async () => {
      for await (const _ of g.routeStream({} as any, req)) {
        /* drain */
      }
    };
    await drain().catch(() => {});
    expect(g.getCircuitBreakerRegistry().get("a")!.getState()).toBe("CLOSED");
    mode = "fail";
    await drain().catch(() => {});
    expect(g.getCircuitBreakerRegistry().get("a")!.getState()).toBe("OPEN");
    const err = await drain().then(
      () => null,
      (e) => e,
    );
    expect(err?.statusCode).toBe(503);
    expect(a.calls).toBe(2);
  });
});
