/**
 * Review 2026-11-05, batch B (quota accounting) — fixed. Each case started as
 * a repro of the bug (work/review-2026-11-05/repros/fixes, abuse-data):
 *
 *  F1  max_completion_tokens (decoy 1) + max_tokens (9,999,999): the limit
 *      check and the reservation only looked at max_completion_tokens while
 *      both were forwarded → RB6 and RB3 bypassed (40 concurrent requests on
 *      a 1000-token quota used 12,360). Now: both set and different → 400
 *      conflicting_max_tokens; the effective cap is the larger field.
 *  F2  a non-streaming request whose client went away after it was sent
 *      upstream counted 0 tokens. Now: estimated prompt + a slow time-based
 *      output estimate (ABORTED_CALL_OUTPUT_TOKENS_PER_SECOND, ≤ the cap).
 *  D4  a gateway timeout (504) also counted 0 tokens and was a breaker
 *      failure: 3 slow requests from one key opened the circuit for everyone.
 *      Now metered like F2, and a timeout is a breaker failure only with
 *      circuitBreaker.countTimeouts: true.
 *  F3  an MCP loop that failed (mcp_depth_exceeded) dropped the usage of
 *      the rounds it had completed. Now they are metered.
 *  F5  reservation TTL with unbounded streams ignored a longer requestTimeout.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createTimeoutReason } from "@/core/outcome";
import { ABORTED_CALL_OUTPUT_TOKENS_PER_SECOND } from "@/core/pipeline";
import { applyPassthroughMaxTokens, passthroughMaxTokens } from "@/core/surfaces/passthrough";
import { KeyMeter, reservationTtlMs } from "@/usage/key-meter";
import { chatJson, fakeFetch, makeGateway, meteredClient, sse, target } from "./_review";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});
const msg = [{ role: "user" as const, content: "x" }];

async function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "200",
    (e) => `${e?.status ?? e?.statusCode ?? e?.name} ${e?.code ?? ""}`.trim(),
  );
}

describe("F1 both output-limit fields", () => {
  it("max_tokens 9,999,999 + max_completion_tokens 1 → 400 conflicting_max_tokens, nothing sent upstream", async () => {
    const f = fakeFetch(() => chatJson("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const r = await outcome(
      gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 9_999_999, maxCompletionTokens: 1 }),
    );
    expect(r).toBe("400 conflicting_max_tokens");
    // Reversed decoy too.
    const r2 = await outcome(
      gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 1, maxCompletionTokens: 9_999_999 }),
    );
    expect(r2).toBe("400 conflicting_max_tokens");
    expect(f.calls).toHaveLength(0);
  });

  it("the same value in both fields is accepted and checked: over the limit → 400 max_tokens_exceeded", async () => {
    const f = fakeFetch(() => chatJson("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    await gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 300, maxCompletionTokens: 300 });
    expect(f.calls[0]!.body.max_tokens).toBe(300);
    const r = await outcome(
      gw.route({ metadata: {} } as never, {
        model: "m",
        messages: msg,
        maxTokens: 9_999_999,
        maxCompletionTokens: 9_999_999,
      }),
    );
    expect(r).toBe("400 max_tokens_exceeded");
    expect(f.calls).toHaveLength(1);
  });

  it("the reservation uses the larger field: 40 concurrent requests on a 1000 quota admit ≤ 4", async () => {
    const TRUE = { prompt_tokens: 9, completion_tokens: 300, total_tokens: 309 };
    const f = fakeFetch(async () => {
      await Bun.sleep(150);
      return chatJson("y".repeat(1200), TRUE);
    });
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("f1", 1000) };
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        outcome(gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 300, maxCompletionTokens: 300 })),
      ),
    );
    const ok = results.filter((r) => r === "200").length;
    expect(ok).toBeLessThanOrEqual(4);
    expect(gw.keyMeter().used("f1")!).toBeLessThanOrEqual(1000 + 309);
  });

  it("pass-through bodies: the largest of max_output_tokens / max_completion_tokens / max_tokens is the cap, and a cap lowers every field", () => {
    const body = { model: "m", max_output_tokens: 1, max_tokens: 9_999_999 };
    expect(passthroughMaxTokens(body, "max_output_tokens")).toBe(9_999_999);
    const rewritten = JSON.parse(applyPassthroughMaxTokens(body, "max_output_tokens", 100)!);
    expect(rewritten).toEqual({ model: "m", max_output_tokens: 1, max_tokens: 100 });
    expect(applyPassthroughMaxTokens({ model: "m", max_tokens: 50 }, "max_tokens", 100)).toBeUndefined();
    expect(JSON.parse(applyPassthroughMaxTokens({ model: "m" }, "max_output_tokens", 100)!)).toEqual({
      model: "m",
      max_output_tokens: 100,
    });
  });
});

describe("F2 / D4 aborted or timed-out non-streaming calls are metered", () => {
  it("client abort after the request reached upstream: prompt + time-based output estimate, never 0", async () => {
    let upstreamFinished = 0;
    const f = fakeFetch(async (_u, init) => {
      await Bun.sleep(200);
      upstreamFinished++;
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return chatJson("y".repeat(40000), { prompt_tokens: 9, completion_tokens: 10000, total_tokens: 10009 });
    });
    restore = f.restore;
    const { gw, logs } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const client = meteredClient("f2", 1000);
    const big = [{ role: "user" as const, content: "p".repeat(400) }]; // ≈ 104 prompt tokens
    for (let i = 0; i < 5; i++) {
      const ac = new AbortController();
      const p = gw.route({ metadata: {}, client, signal: ac.signal } as never, {
        model: "m",
        messages: big,
        maxTokens: 10000,
      });
      setTimeout(() => ac.abort(), 180);
      await outcome(p);
    }
    await Bun.sleep(300);
    expect(upstreamFinished).toBe(5);
    const used = gw.keyMeter().used("f2") ?? 0;
    // 5 × (≈104 prompt + 0.18 s × 10 tok/s → 1) — an estimate, not 0 and not the 10,000 cap.
    expect(used).toBeGreaterThanOrEqual(5 * 104);
    expect(used).toBeLessThan(5 * 200);
    expect(gw.keyMeter().reserved("f2")).toBe(0);
    const entry = logs.at(-1)!;
    expect(entry.usageEstimated).toBe(true);
    expect(entry.tokens?.prompt).toBeGreaterThanOrEqual(104);
  });

  it("output estimate grows with the time the call ran, capped by max_tokens", async () => {
    const f = fakeFetch(async (_u, init) => {
      await new Promise((_res, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
      );
      return chatJson("never");
    });
    restore = f.restore;
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const run = async (id: string, maxTokens: number, ms: number) => {
      const ac = new AbortController();
      const p = gw.route({ metadata: {}, client: meteredClient(id, 100000), signal: ac.signal } as never, {
        model: "m",
        messages: msg,
        maxTokens,
      });
      setTimeout(() => ac.abort(), ms);
      await outcome(p);
      return gw.keyMeter().used(id) ?? 0;
    };
    const prompt = 5; // "x": 4 framing + 1
    const long = await run("t-long", 10000, 1100);
    expect(long).toBeGreaterThanOrEqual(prompt + Math.floor(1 * ABORTED_CALL_OUTPUT_TOKENS_PER_SECOND));
    expect(long).toBeLessThan(prompt + 3 * ABORTED_CALL_OUTPUT_TOKENS_PER_SECOND);
    const capped = await run("t-cap", 3, 1100);
    expect(capped).toBe(prompt + 3);
  });

  it("a request aborted while still queued for a slot (never sent upstream) costs nothing", async () => {
    const f = fakeFetch(async () => {
      await Bun.sleep(300);
      return chatJson("ok", { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 });
    });
    restore = f.restore;
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [target("a", ["m"], { concurrency: { maxConcurrency: 1, queueSize: 10 } })],
    });
    const first = gw.route({ metadata: {} } as never, { model: "m", messages: msg });
    const ac = new AbortController();
    const queued = gw.route({ metadata: {}, client: meteredClient("q", 1000), signal: ac.signal } as never, {
      model: "m",
      messages: msg,
    });
    setTimeout(() => ac.abort(), 50);
    await outcome(queued);
    await first;
    expect(gw.keyMeter().used("q") ?? 0).toBe(0);
  });

  it("D4: 3 gateway timeouts from one key do not open the breaker (default), and are metered", async () => {
    const f = fakeFetch(async (_u, init) => {
      await new Promise((_res, rej) =>
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason ?? new Error("aborted"))),
      );
      return chatJson("never");
    });
    restore = f.restore;
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [target("a", ["m"], { circuitBreaker: { failureThreshold: 3, timeoutMs: 60_000 } })],
    });
    const client = meteredClient("slow", 100000);
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ac = new AbortController();
      const p = gw.route({ metadata: {}, client, signal: ac.signal } as never, {
        model: "m",
        messages: msg,
        maxTokens: 8000,
      });
      setTimeout(() => ac.abort(createTimeoutReason(100)), 100);
      results.push(await outcome(p));
    }
    expect(results.every((r) => r === "504 gateway_timeout")).toBe(true);
    expect(gw.getCircuitBreakerRegistry().get("a")!.getState()).toBe("CLOSED");
    expect(gw.keyMeter().used("slow")!).toBeGreaterThanOrEqual(5 * 5);
  });

  it("D4: with circuitBreaker.countTimeouts the same timeouts do open it", async () => {
    const f = fakeFetch(async (_u, init) => {
      await new Promise((_res, rej) =>
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason ?? new Error("aborted"))),
      );
      return chatJson("never");
    });
    restore = f.restore;
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [
        target("a", ["m"], { circuitBreaker: { failureThreshold: 3, timeoutMs: 60_000, countTimeouts: true } }),
      ],
    });
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      const ac = new AbortController();
      const p = gw.route({ metadata: {}, signal: ac.signal } as never, { model: "m", messages: msg });
      setTimeout(() => ac.abort(createTimeoutReason(50)), 50);
      results.push(await outcome(p));
    }
    expect(results.slice(0, 3)).toEqual(["504 gateway_timeout", "504 gateway_timeout", "504 gateway_timeout"]);
    expect(results[3]).toBe("503 circuit_open");
  });

  it("a stream cancelled before its first chunk is charged its prompt (no output yet)", async () => {
    const f = fakeFetch(async (_u, init) => {
      await new Promise((_res, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
      );
      return new Response(sse([]), { headers: { "content-type": "text/event-stream" } });
    });
    restore = f.restore;
    const { gw, logs } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ac = new AbortController();
    const it = gw.routeStream({ metadata: {}, client: meteredClient("s", 1000), signal: ac.signal } as never, {
      model: "m",
      messages: [{ role: "user", content: "p".repeat(400) }],
      maxTokens: 5000,
      stream: true,
    });
    setTimeout(() => ac.abort(), 600);
    await outcome(it.next());
    const used = gw.keyMeter().used("s") ?? 0;
    expect(used).toBe(104); // prompt only: no time-based output for a stream with no chunk
    expect(logs.at(-1)!.usageEstimated).toBe(true);
    expect(gw.keyMeter().reserved("s")).toBe(0);
  });
});

describe("F3 failed MCP loops meter the rounds they completed", () => {
  const SERVER = join(import.meta.dir, "prev", "mcp-echo-server.cjs");
  it("mcp_depth_exceeded after 4 upstream calls × 4000 tokens → 16,000 charged per request", async () => {
    let n = 0;
    const f = fakeFetch(() =>
      Response.json({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: `call_${n++}`, type: "function", function: { name: "echo", arguments: '{"text":"a"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 3000, completion_tokens: 1000, total_tokens: 4000 },
      }),
    );
    restore = f.restore;
    const { gw, logs } = makeGateway({
      strategy: { mode: "single" },
      targets: [target("a")],
      mcpServers: [
        { name: "echo", command: "node", args: [SERVER], timeoutSeconds: 5, maxCallDepth: 3, required: false },
      ],
    });
    await (gw as unknown as { initMcp(): Promise<void> }).initMcp();
    try {
      const client = meteredClient("f3", 100000);
      for (let i = 0; i < 3; i++) {
        const r = await outcome(
          gw.route({ metadata: {}, client } as never, {
            model: "m",
            messages: [{ role: "user", content: "loop" }],
            maxTokens: 1000,
          }),
        );
        expect(r).toBe("502 mcp_depth_exceeded");
      }
      expect(f.calls.length).toBe(12);
      expect(gw.keyMeter().used("f3")).toBe(48000);
      expect(logs.at(-1)!.tokens?.total).toBe(16000);
      expect(gw.keyMeter().reserved("f3")).toBe(0);
    } finally {
      await (gw as unknown as { shutdown?: () => Promise<void> }).shutdown?.().catch(() => undefined);
    }
  }, 20000);

  it("a later round's upstream error still meters the earlier rounds", async () => {
    let n = 0;
    const f = fakeFetch(() => {
      if (n++ === 0) {
        return Response.json({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c0", type: "function", function: { name: "echo", arguments: '{"text":"a"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 3000, completion_tokens: 1000, total_tokens: 4000 },
        });
      }
      return Response.json({ error: { message: "bad request" } }, { status: 400 });
    });
    restore = f.restore;
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [target("a")],
      mcpServers: [
        { name: "echo", command: "node", args: [SERVER], timeoutSeconds: 5, maxCallDepth: 3, required: false },
      ],
    });
    await (gw as unknown as { initMcp(): Promise<void> }).initMcp();
    try {
      const r = await outcome(
        gw.route({ metadata: {}, client: meteredClient("f3b", 100000) } as never, {
          model: "m",
          messages: [{ role: "user", content: "loop" }],
        }),
      );
      expect(r.startsWith("400")).toBe(true);
      expect(gw.keyMeter().used("f3b")).toBe(4000);
    } finally {
      await (gw as unknown as { shutdown?: () => Promise<void> }).shutdown?.().catch(() => undefined);
    }
  }, 20000);
});

describe("F5 reservation TTL with unbounded streams", () => {
  it("is the larger of 1 h and requestTimeout + 1 min", () => {
    expect(reservationTtlMs(7_200_000, 0)).toBe(7_260_000);
    expect(reservationTtlMs(30_000, 0)).toBe(3_600_000);
    expect(reservationTtlMs(30_000, 600_000)).toBe(660_000);
    const m = new KeyMeter();
    const key = { id: "k", limits: { quotaTokens: 1000, rpm: null, tpm: null } };
    const t0 = 1_000_000;
    m.admit(key, { reserve: () => 1000, reservationTtlMs: reservationTtlMs(7_200_000, 0), now: t0 });
    // Still running after 1 h (requestTimeout is 2 h): the reservation holds.
    expect(() => m.admit(key, { reserve: () => 995, now: t0 + 3_600_001 })).toThrow();
  });
});
