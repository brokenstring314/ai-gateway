// Non-fallback strategies pick exactly one target and never move on, so an OPEN breaker
// (or a dead target) on the chosen target is a hard 503/500 even though healthy targets exist.
import { describe, it, expect } from "bun:test";
import { mk, req, tgt, code } from "./_h";
const cb = { failureThreshold: 1, timeoutMs: 60_000 };

describe("strategies do not route around an open breaker", () => {
  it("loadbalance: half of all traffic gets 503 CircuitOpen while the other target is healthy", async () => {
    const { g } = mk({ strategy: { mode: "loadbalance" }, targets: [tgt("a", { circuitBreaker: cb }), tgt("b", { circuitBreaker: cb })] }, ["a", "b"], { a: "fail", b: "ok" });
    const r: string[] = [];
    for (let i = 0; i < 200; i++) r.push(await code(g.route({} as any, req)));
    const fails = r.filter((x) => !x.startsWith("ok")).length;
    console.log("loadbalance failures:", fails, "/ 200");
    expect(fails).toBeLessThan(5); // FAILS: ~100
  });
});

// ── R3-H3: shared candidate executor, beyond the original repro ──
import { LoadBalanceStrategy } from "@/routing/loadbalance";
import { ConditionalStrategy } from "@/routing/conditional";

function streamProvider(name: string, mode: "ok" | "fail-before" | "fail-after" | "400") {
  const calls = { n: 0 };
  return {
    calls,
    p: {
      name,
      models: () => [],
      complete: async () => { throw new Error("unused"); },
      completeStream: async function* () {
        calls.n++;
        if (mode === "fail-before") throw Object.assign(new Error("down"), { statusCode: 503 });
        if (mode === "400") throw Object.assign(new Error("bad"), { statusCode: 400 });
        yield { id: name, choices: [{ index: 0, delta: { content: name } }] } as any;
        if (mode === "fail-after") throw Object.assign(new Error("broke"), { statusCode: 502 });
        yield { id: name, choices: [{ index: 0, delta: { content: "!" } }] } as any;
      },
    } as any,
  };
}

async function drain(it: AsyncIterable<any>): Promise<string> {
  let out = "";
  try {
    for await (const c of it) out += c.choices[0].delta.content;
    return "ok:" + out;
  } catch (e: any) {
    return `err(${e.statusCode}):` + out;
  }
}

describe("shared candidate executor", () => {
  it("abtest alias (-> loadbalance): a target behind an open breaker fails over to the other one", async () => {
    const { g } = mk({ strategy: { mode: "abtest" }, targets: [tgt("a", { circuitBreaker: cb }), tgt("b")] }, ["a", "b"], { a: "fail", b: "ok" });
    const r: string[] = [];
    for (let i = 0; i < 40; i++) r.push(await code(g.route({} as any, req)));
    expect(r.every((x) => x === "ok:b")).toBe(true);
  });

  it("conditional: matched target down -> default target serves", async () => {
    const { g } = mk({ strategy: { mode: "conditional", targets: ["dflt"], rules: [{ field: "model", pattern: "^m$", target: "special" }] },
      targets: [tgt("dflt"), tgt("special", { circuitBreaker: cb })] }, ["dflt", "special"], { special: "fail", dflt: "ok" });
    for (let i = 0; i < 5; i++) expect(await code(g.route({} as any, req))).toBe("ok:dflt");
  });

  it("caller-caused 400 is not failed over (loadbalance)", async () => {
    const { g, calls } = mk({ strategy: { mode: "loadbalance" }, targets: [tgt("a"), tgt("b")] }, ["a", "b"], { a: "400", b: "400" });
    expect(await code(g.route({} as any, req))).toBe("400");
    expect(calls["a"]! + calls["b"]!).toBe(1);
  });

  it("per-target retry config is honoured before failing over", async () => {
    const { g, calls } = mk({ strategy: { mode: "loadbalance" }, targets: [
      tgt("a", { weight: 1000, retry: { attempts: 3, initialBackoffMs: 1 } }), tgt("b", { weight: 0.0001 })] }, ["a", "b"], { a: "fail", b: "ok" });
    let okB = 0;
    for (let i = 0; i < 5; i++) if ((await code(g.route({} as any, req))) === "ok:b") okB++;
    expect(okB).toBe(5);
    expect(calls["a"]).toBeGreaterThanOrEqual(13); // ~3 attempts per request on a (b may rarely be first)
  });

  it("stream: fails over before the first chunk, never after output started", async () => {
    const a = streamProvider("a", "fail-before");
    const b = streamProvider("b", "ok");
    const lb = new LoadBalanceStrategy((n) => (n === "a" ? a.p : b.p), { targets: [{ name: "a", weight: 1e9 }, { name: "b", weight: 1e-9 }] });
    expect(await drain(lb.executeStream({ metadata: {} } as any, req as any))).toBe("ok:b!");

    const a2 = streamProvider("a", "fail-after");
    const b2 = streamProvider("b", "ok");
    const lb2 = new LoadBalanceStrategy((n) => (n === "a" ? a2.p : b2.p), { targets: [{ name: "a", weight: 1e9 }, { name: "b", weight: 1e-9 }] });
    expect(await drain(lb2.executeStream({ metadata: {} } as any, req as any))).toBe("err(502):a");
    expect(b2.calls.n).toBe(0);
  });

  it("conditional strategy with nothing matched and no default still errors", async () => {
    const c = new ConditionalStrategy(() => undefined, { rules: [] });
    await expect(c.execute({ metadata: {} } as any, req as any)).rejects.toThrow("no rule matched");
  });
});
