/**
 * RB5 (red team 2026-11-02) — fixed: one upstream 429 cooled the channel's
 * shared key for the upstream's Retry-After (120 s in the PoC, up to an
 * hour), so every other client got 429 / 503 no_upstream_key; repeatable at
 * will, and five 429s also opened the circuit breaker for everyone. Now a
 * 429 cooldown is soft (a cooled key is still used when no other key is
 * usable), Retry-After is honoured but capped at keyCooldownSeconds (default
 * 30), and 429 does not count as a breaker failure.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chatJson, fakeFetch, makeGateway, target } from "./_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

/** PoC upstream: model "flaky429" always answers 429 Retry-After 120; "metered" works. */
function pocUpstream() {
  const f = fakeFetch((_u, _i, body) =>
    body?.model === "flaky429"
      ? new Response(JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }), {
          status: 429,
          headers: { "Retry-After": "120", "content-type": "application/json" },
        })
      : chatJson("ok", USAGE),
  );
  restore = f.restore;
  return f;
}

async function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "200",
    (e) => `${e?.status ?? e?.statusCode} ${e?.code ?? ""}`.trim(),
  );
}

describe("RB5 upstream 429 does not take the channel down", () => {
  it("PoC: attacker's 429 (Retry-After 120) → victim on the same key still served", async () => {
    pocUpstream();
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [target("a", ["metered", "flaky429"])],
    });
    const events: Array<{ kind: string; seconds?: number }> = [];
    gw.onKeyEvent((e) => events.push(e as never));
    const msg = [{ role: "user" as const, content: "hi" }];
    expect(await outcome(gw.route({ metadata: {} } as never, { model: "metered", messages: msg }))).toBe("200");
    expect(await outcome(gw.route({ metadata: {} } as never, { model: "flaky429", messages: msg }))).toMatch(/^429/);
    // Before: victim AFTER → 429 upstream_rate_limited for 120 s.
    expect(await outcome(gw.route({ metadata: {} } as never, { model: "metered", messages: msg }))).toBe("200");
    // Retry-After 120 capped at keyCooldownSeconds (30).
    expect(events.find((e) => e.kind === "cooldown")?.seconds).toBe(30);
  });

  it("repeated 429s never give 503 no_upstream_key and do not open the breaker", async () => {
    pocUpstream();
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [
        target("a", ["metered", "flaky429"], {
          retry: { attempts: 1 },
          circuitBreaker: { failureThreshold: 3, timeoutMs: 60_000 },
        }),
      ],
    });
    const msg = [{ role: "user" as const, content: "hi" }];
    for (let i = 0; i < 10; i++) {
      const r = await outcome(gw.route({ metadata: {} } as never, { model: "flaky429", messages: msg }));
      expect(r).toMatch(/^429/);
      expect(r).not.toContain("no_upstream_key");
    }
    expect(await outcome(gw.route({ metadata: {} } as never, { model: "metered", messages: msg }))).toBe("200");
  });

  it("with two keys, the request that hit 429 is retried on the other key", async () => {
    let first = true;
    const f = fakeFetch(() => {
      if (first) {
        first = false;
        return new Response("{}", { status: 429, headers: { "Retry-After": "5" } });
      }
      return chatJson("ok", USAGE);
    });
    restore = f.restore;
    const { gw } = makeGateway({
      strategy: { mode: "single" },
      targets: [{ ...target("a"), apiKey: undefined, apiKeys: ["sk-one-00000000", "sk-two-00000000"] }],
    });
    const msg = [{ role: "user" as const, content: "hi" }];
    expect(await outcome(gw.route({ metadata: {} } as never, { model: "m", messages: msg }))).toBe("200");
    expect(f.calls).toHaveLength(2);
  });
});
