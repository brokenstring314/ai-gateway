import { describe, it, expect } from "bun:test";
import type { FallbackStrategy } from "@/routing/fallback";
import type { BoundStrategy } from "./helpers";
import { ProviderError } from "@/providers/openai-compat";
import type { IProvider, StreamChunk } from "@/providers/types";
import { boundFallback } from "./helpers";

// Regression: H14 — no fail-over after output started; per-target retry
// applies to streams (failure before the first chunk).

const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
const chunk = (c: string): StreamChunk => ({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: c }, finishReason: "" }] });
function prov(name: string, stream: () => AsyncGenerator<StreamChunk>): IProvider {
  return { name, complete: async () => { throw new Error("n/a"); }, completeStream: stream, supportedModels: () => [], supportsModel: () => true, models: () => [] } as any;
}
async function run(s: BoundStrategy<FallbackStrategy>) {
  const out: string[] = []; let err: unknown = null;
  try { for await (const c of s.executeStream({} as any, req)) out.push(c.choices[0]!.delta?.content as string); } catch (e) { err = e; }
  return { out, err };
}

describe("FallbackStrategy.executeStream", () => {
  it("rethrows after output started instead of splicing the next target", async () => {
    const boom = new ProviderError("a", 502, "boom");
    const a = prov("a", async function* () { yield chunk("A1"); throw boom; });
    const b = prov("b", async function* () { yield chunk("B1"); });
    const { out, err } = await run(boundFallback((n) => ({ a, b } as any)[n], { targets: ["a", "b"] }));
    expect(out).toEqual(["A1"]);
    expect(err).toBe(boom);
  });

  it("fails over when the error happens before the first chunk", async () => {
    const a = prov("a", async function* () { throw new ProviderError("a", 502, "boom"); });
    const b = prov("b", async function* () { yield chunk("B1"); yield chunk("B2"); });
    const { out, err } = await run(boundFallback((n) => ({ a, b } as any)[n], { targets: ["a", "b"] }));
    expect(out).toEqual(["B1", "B2"]);
    expect(err).toBeNull();
  });

  it("applies per-target retry to a pre-first-chunk stream failure", async () => {
    let calls = 0;
    const a = prov("a", async function* () { calls++; if (calls === 1) throw new ProviderError("a", 503, "x"); yield chunk("ok"); });
    const { out } = await run(boundFallback((n) => ({ a } as any)[n], { targets: ["a"], retryConfigs: new Map([["a", { attempts: 2, initialBackoffMs: 1 }]]) }));
    expect(out).toEqual(["ok"]);
    expect(calls).toBe(2);
  });

  it("closes the upstream iterator when the consumer stops early", async () => {
    let closed = false;
    const a = prov("a", async function* () { try { yield chunk("1"); yield chunk("2"); } finally { closed = true; } });
    const s = boundFallback((n) => ({ a } as any)[n], { targets: ["a"] });
    for await (const _ of s.executeStream({} as any, req)) break;
    expect(closed).toBe(true);
  });
});
