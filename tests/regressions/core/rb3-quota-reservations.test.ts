/**
 * RB3 (red team 2026-11-02) — fixed: the quota check (admit, before the
 * upstream call) and the accounting (finalize, after it) had no reservation
 * in between, so N concurrent requests all read the old `used`. PoC: quota
 * 1000, 40 concurrent requests of a true 309 tokens each on a slow upstream
 * → 40 × 200, 12,320 tokens billed (12× the quota). Now an admitted request
 * reserves its estimated prompt + output cap until it settles, and a request
 * is admitted only while used + reserved < quota (429 quota_in_flight
 * otherwise); reservations are released on success, error, client cancel and
 * failover. The same reservation counts toward TPM.
 *
 * Safety net (follow-up): a reservation that is never settled — a stream
 * iterator dropped without return(), so finalize never runs — expires after
 * the request lifetime bound (max(requestTimeout, streamMaxDurationSeconds)
 * + 60 s, or 1 h when streams are unbounded) and is swept on the key's next
 * admit, instead of holding the quota forever.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { StreamChunk } from "@/providers/types";
import { chatJson, chunk, fakeFetch, makeGateway, meteredClient, sse, target } from "./_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const msg = [{ role: "user" as const, content: "x" }];
const TRUE = { prompt_tokens: 9, completion_tokens: 300, total_tokens: 309 };

function slowUpstream(ms = 150) {
  const f = fakeFetch(async () => {
    await Bun.sleep(ms);
    return chatJson("y".repeat(1200), TRUE);
  });
  restore = f.restore;
  return f;
}

async function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "200",
    (e) => `${e?.status ?? e?.statusCode} ${e?.code ?? ""}`.trim(),
  );
}

describe("RB3 quota reservations", () => {
  it("PoC numbers: 40 concurrent, quota 1000, 309 tokens each → overshoot bounded by one request", async () => {
    const f = slowUpstream();
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("rb3", 1000) };
    const results = await Promise.all(
      Array.from({ length: 40 }, () => outcome(gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 300 }))),
    );
    const ok = results.filter((r) => r === "200").length;
    // Reservation 5 + 300 = 305 each, admitted while all reservations fit the
    // quota (final red team 2026-11-06 FQ-1): 305, 610, 915 ≤ 1000 → 3 admitted.
    expect(ok).toBe(3);
    expect(results.filter((r) => r === "429 quota_in_flight")).toHaveLength(37);
    expect(f.calls).toHaveLength(3);
    const used = gw.keyMeter().used("rb3")!;
    expect(used).toBe(3 * 309);
    expect(used).toBeLessThanOrEqual(1000); // before RB3: 11,320 over; before FQ-1: one request over
    expect(gw.keyMeter().reserved("rb3")).toBe(0);
    // 73 tokens left: a 305-token request no longer fits (FQ-2) — 400, never clamped.
    expect(await outcome(gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 300 }))).toBe(
      "400 request_exceeds_quota",
    );
    // A request that fits the rest is still served; afterwards the quota is used up: 403.
    expect(await outcome(gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 60 }))).toBe("200");
    expect(await outcome(gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 1 }))).toBe(
      "403 quota_exhausted",
    );
  });

  it("a request without max_tokens reserves the global output cap (one in flight at a time) and sends it upstream", async () => {
    const f = slowUpstream(80);
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("rb3b", 100_000) };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => outcome(gw.route(ctx as never, { model: "m", messages: msg }))),
    );
    // 65536 + prompt reserved by the first; 65541 + 65541 > 100000: the others wait.
    expect(results.filter((r) => r === "200")).toHaveLength(1);
    expect(results.filter((r) => r === "429 quota_in_flight")).toHaveLength(4);
    expect(gw.keyMeter().reserved("rb3b")).toBe(0);
    // FQ-2: the reserved ceiling went upstream, so the upstream cannot exceed it.
    expect(f.calls[0]!.body.max_tokens).toBe(65_536);
  });

  it("an upstream error, a failover and a client cancel all release the reservation", async () => {
    let n = 0;
    const f = fakeFetch((u) => {
      n++;
      if (u.hostname.startsWith("bad")) return Response.json({ error: { message: "boom" } }, { status: 500 });
      return new Response(sse([chunk("hello"), chunk(" world", "stop")]), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    restore = f.restore;
    const { gw } = makeGateway({
      strategy: { mode: "fallback", targets: ["bad", "good"] },
      targets: [target("bad", ["m"], { retry: { attempts: 1 } }), target("good")],
    });
    const ctx = { metadata: {}, client: meteredClient("rb3c", 1_000_000) };
    // Failover bad → good, then the client stops after the first chunk.
    const gen = gw.routeStream(ctx as never, { model: "m", messages: msg, maxTokens: 500, stream: true });
    const first = (await gen.next()).value as StreamChunk;
    expect(first.choices[0]?.delta?.content).toBe("hello");
    expect(gw.keyMeter().reserved("rb3c")).toBeGreaterThan(500);
    await gen.return(undefined);
    await Bun.sleep(5);
    expect(gw.keyMeter().reserved("rb3c")).toBe(0);
    expect(n).toBeGreaterThanOrEqual(2);

    // Every target fails: the error releases it too.
    const only = makeGateway({
      strategy: { mode: "single" },
      targets: [target("bad", ["m"], { retry: { attempts: 1 } })],
    }).gw;
    const ctx2 = { metadata: {}, client: meteredClient("rb3d", 1_000_000) };
    expect(await outcome(only.route(ctx2 as never, { model: "m", messages: msg, maxTokens: 500 }))).toMatch(/^5/);
    expect(only.keyMeter().reserved("rb3d")).toBe(0);
  });

  it("a rejected request (over max_tokens) releases its reservation", async () => {
    slowUpstream(1);
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: meteredClient("rb3e", 1_000_000) };
    expect(await outcome(gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 9_999_999 }))).toBe(
      "400 max_tokens_exceeded",
    );
    expect(gw.keyMeter().reserved("rb3e")).toBe(0);
  });

  it("TPM counts in-flight reservations", async () => {
    slowUpstream(80);
    const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
    const ctx = { metadata: {}, client: { id: "rb3t", limits: { quotaTokens: null, rpm: null, tpm: 1000 } } };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => outcome(gw.route(ctx as never, { model: "m", messages: msg, maxTokens: 300 }))),
    );
    expect(results.filter((r) => r === "200")).toHaveLength(4);
    expect(results.filter((r) => r === "429 rate_limit_exceeded")).toHaveLength(6);
    expect(gw.keyMeter().reserved("rb3t")).toBe(0);
  });

  it("a reservation whose request never finalizes is released after the request-lifetime TTL", async () => {
    const f = fakeFetch((_u, _i, body) =>
      body?.stream === true
        ? new Response(sse([chunk("hello"), chunk(" world", "stop")]), {
            headers: { "content-type": "text/event-stream" },
          })
        : chatJson("ok", { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }),
    );
    restore = f.restore;
    try {
      const { gw } = makeGateway({
        strategy: { mode: "single" },
        targets: [target("a")],
        requestTimeout: "30s",
        server: { streamMaxDurationSeconds: 120 },
      });
      const ctx = { metadata: {}, client: meteredClient("rb3leak", 1000) };
      // Admitted, first chunk read, then the iterator is abandoned: finalize never runs.
      const leaked = gw.routeStream(ctx as never, { model: "m", messages: msg, maxTokens: 995, stream: true });
      expect(((await leaked.next()).value as StreamChunk).choices[0]?.delta?.content).toBe("hello");
      expect(gw.keyMeter().reserved("rb3leak")).toBeGreaterThanOrEqual(1000);
      const req = { model: "m", messages: msg, maxTokens: 50 };
      expect(await outcome(gw.route(ctx as never, req))).toBe("429 quota_in_flight");

      // TTL = max(30 s, 120 s) + 60 s = 180 s. Just before: still held.
      const t0 = Date.now();
      setSystemTime(new Date(t0 + 179_000));
      expect(gw.keyMeter().reserved("rb3leak")).toBeGreaterThanOrEqual(1000);
      setSystemTime(new Date(t0 + 181_000));
      expect(gw.keyMeter().reserved("rb3leak")).toBe(0);
      expect(gw.keyMeter().expiredReservations()).toBe(1);
      expect(await outcome(gw.route(ctx as never, req))).toBe("200");
      expect(gw.keyMeter().reserved("rb3leak")).toBe(0);
    } finally {
      setSystemTime();
    }
  });
});
