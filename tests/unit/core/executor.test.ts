import { describe, expect, it } from "bun:test";
import { TargetExecutor, executeChat } from "@/core/executor";
import { classifyAttemptError, createTimeoutReason } from "@/core/outcome";
import { CircuitBreaker } from "@/routing/circuit-breaker";
import { ConcurrencyLimiter } from "@/routing/concurrency-limiter";
import { SingleStrategy } from "@/routing/single";
import { ProviderError } from "@/providers/openai-compat";
import type { IProvider, RequestContext } from "@/providers/types";

const ctx = (signal?: AbortSignal): RequestContext => ({ metadata: {}, ...(signal ? { signal } : {}) });

const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
const ok = (name: string) => ({ id: "x", object: "chat.completion", created: 0, model: "m", provider: name, choices: [] });

function provider(name: string, impl: () => Promise<unknown>): IProvider {
  return { name, complete: impl, supportedModels: () => [], supportsModel: () => true, models: () => [] } as unknown as IProvider;
}

describe("classifyAttemptError (plan §1.4)", () => {
  const timedOut = () => { const ac = new AbortController(); ac.abort(createTimeoutReason(1)); return ac.signal; };
  const clientAbort = () => { const ac = new AbortController(); ac.abort(); return ac.signal; };
  it.each([
    ["not admitted", new Error("x"), { admitted: false }, "release"],
    ["deadline before output", new Error("x"), { admitted: true, signal: timedOut() }, "failure"],
    ["deadline after output", new Error("x"), { admitted: true, signal: timedOut(), started: true }, "release"],
    ["client abort, no output", new Error("x"), { admitted: true, signal: clientAbort() }, "release"],
    ["client abort after output", new Error("x"), { admitted: true, signal: clientAbort(), started: true }, "success"],
    ["upstream 400", new ProviderError("t", 400, "bad"), { admitted: true }, "release"],
    ["upstream 404", new ProviderError("t", 404, "nf"), { admitted: true }, "release"],
    ["upstream 401", new ProviderError("t", 401, "auth"), { admitted: true }, "failure"],
    ["upstream 500", new ProviderError("t", 500, "x"), { admitted: true }, "failure"],
    ["network", new ProviderError("t", 0, "reset"), { admitted: true }, "failure"],
  ] as const)("%s -> %s", (_n, err, facts, breaker) => {
    expect(classifyAttemptError(err, facts as never).breaker).toBe(breaker);
  });
});

describe("TargetExecutor", () => {
  it("per-target retry applies to every strategy (single included)", async () => {
    let n = 0;
    const p = provider("a", async () => { if (++n < 3) throw new ProviderError("a", 503, "busy"); return ok("a"); });
    const ex = new TargetExecutor({ lookup: () => p, retryConfig: () => ({ attempts: 3, initialBackoffMs: 1 }) });
    const res = await executeChat(ex, new SingleStrategy({ target: "a" }), ctx(), req);
    expect(res.provider).toBe("a");
    expect(n).toBe(3);
  });

  it("a request timing out in the limiter queue releases its breaker permit and is a 429 overload", async () => {
    const breaker = new CircuitBreaker("a", { failureThreshold: 1, timeoutMs: 60_000 });
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1 });
    let calls = 0;
    const p = provider("a", async () => { calls++; await Bun.sleep(100); return ok("a"); });
    const ex = new TargetExecutor({ lookup: () => p, breaker: () => breaker, limiter: () => limiter });
    const long = ex.run(ctx(), ["a"], (pr) => pr.complete(ctx(), req), { label: "t" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(createTimeoutReason(20)), 20);
    const err = (await ex.run(ctx(ac.signal), ["a"], (pr) => pr.complete(ctx(), req), { label: "t" }).catch((e: unknown) => e)) as { status: number; code: string };
    expect(err.status).toBe(429);
    expect(err.code).toBe("gateway_overloaded");
    await long;
    expect(calls).toBe(1);
    expect(breaker.getState()).toBe("CLOSED");
    expect(limiter.inFlight).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it("an OPEN breaker fails over without taking a limiter slot", async () => {
    const breakerA = new CircuitBreaker("a", { failureThreshold: 1, timeoutMs: 60_000 });
    breakerA.recordFailure(breakerA.acquire());
    const limiterA = new ConcurrencyLimiter({ maxConcurrency: 1 });
    const ex = new TargetExecutor({
      lookup: (n) => provider(n, async () => ok(n)),
      breaker: (n) => (n === "a" ? breakerA : undefined),
      limiter: (n) => (n === "a" ? limiterA : undefined),
    });
    const res = (await ex.run(ctx(), ["a", "b"], (pr) => pr.complete(ctx(), req), { label: "t" })) as { provider: string };
    expect(res.provider).toBe("b");
    expect(limiterA.inFlight).toBe(0);
  });
});
