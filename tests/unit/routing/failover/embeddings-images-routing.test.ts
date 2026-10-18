// R3-H6 (B3-2): /v1/embeddings and /v1/images/generations used to bypass the
// routing strategy (first provider listing the model; no fallback, retry,
// breaker or load balancing). They now go through the shared candidate executor.
import { describe, it, expect } from "bun:test";
import { Gateway } from "@/gateway";
import { tgt } from "./_h";

type Mode = "ok" | "500" | "400";
function mkAux(cfg: any, modes: Record<string, Mode>) {
  const g = new Gateway(cfg);
  const calls: Record<string, number> = {};
  for (const n of Object.keys(modes)) {
    calls[n] = 0;
    const fail = () => {
      const m = modes[n];
      if (m !== "ok") throw Object.assign(new Error(`upstream ${m}`), { statusCode: Number(m) });
    };
    g.registerProvider({
      name: n,
      supportedModels: () => [],
      supportsModel: () => true,
      models: () => [],
      complete: async () => { throw new Error("unused"); },
      embed: async (_ctx: any, req: any) => { calls[n] = (calls[n] ?? 0) + 1; fail(); return { object: "list", data: [], model: req.model, provider: n } as any; },
      generateImage: async () => { calls[n] = (calls[n] ?? 0) + 1; fail(); return { created: 0, data: [], provider: n } as any; },
    } as any);
  }
  return { g, calls };
}
const cb = { failureThreshold: 1, timeoutMs: 60_000 };
const status = (p: Promise<any>) => p.then((r) => "ok:" + r.provider, (e) => String(e.statusCode ?? e.message));

describe("embeddings / images go through the routing strategy", () => {
  it("fallback: primary 500 -> backup serves embeddings and images; breaker opens", async () => {
    const { g, calls } = mkAux({ strategy: { mode: "fallback", targets: ["a", "b"] }, targets: [tgt("a", { circuitBreaker: cb }), tgt("b")] }, { a: "500", b: "ok" });
    for (let i = 0; i < 3; i++) {
      expect(await status(g.embed({} as any, { model: "e", input: "x" } as any))).toBe("ok:b");
      expect(await status(g.generateImage({} as any, { model: "i", prompt: "x" } as any))).toBe("ok:b");
    }
    expect(calls["a"]).toBe(1); // breaker opened after the first failure
    expect(g.getCircuitBreakerRegistry().get("a")!.getState()).toBe("OPEN");
  });

  it("loadbalance spreads embeddings across targets", async () => {
    const { g, calls } = mkAux({ strategy: { mode: "loadbalance" }, targets: [tgt("a"), tgt("b")] }, { a: "ok", b: "ok" });
    for (let i = 0; i < 200; i++) await g.embed({} as any, { model: "e", input: "x" } as any);
    expect(calls["a"]).toBeGreaterThan(50);
    expect(calls["b"]).toBeGreaterThan(50);
  });

  it("caller-caused 400 is surfaced without failover", async () => {
    const { g, calls } = mkAux({ strategy: { mode: "fallback", targets: ["a", "b"] }, targets: [tgt("a"), tgt("b")] }, { a: "400", b: "ok" });
    expect(await status(g.embed({} as any, { model: "e", input: "x" } as any))).toBe("400");
    expect(calls["b"]).toBe(0);
  });

  it("per-target retry config applies to embeddings", async () => {
    const { g, calls } = mkAux({ strategy: { mode: "fallback", targets: ["a", "b"] }, targets: [tgt("a", { retry: { attempts: 3, initialBackoffMs: 1 } }), tgt("b")] }, { a: "500", b: "ok" });
    expect(await status(g.embed({} as any, { model: "e", input: "x" } as any))).toBe("ok:b");
    expect(calls["a"]).toBe(3);
  });
});
