/**
 * C7 (review 2026-11-02, redteam RB4) — fixed: a 402 now only cools the key
 * down (softly) and reaches the client as 402. The original repro:
 * any client could take a channel down for everyone. Upstream 402
 * auto-disables the upstream key (key-pool.ts report()), persisted by the
 * config store. Some upstreams answer 402 for a property of the REQUEST,
 * not of the key: OpenRouter returns 402 "This request requires more
 * credits, or fewer max_tokens. You requested up to N tokens, but can only
 * afford M" when max_tokens is larger than the remaining credit allows.
 * One guest request with a large max_tokens disables the operator's key;
 * every later request (any key) gets 503 no_upstream_key until an admin
 * re-enables it by hand.
 */
import { afterEach, expect, it } from "bun:test";
import { chatJson, fakeFetch, makeGateway, target } from "./_review";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

it("a request-caused 402 does not disable the channel's only key", async () => {
  const f = fakeFetch((_u, _i, body) =>
    (body?.max_tokens ?? 0) > 1000
      ? Response.json(
          {
            error: {
              code: 402,
              message:
                "This request requires more credits, or fewer max_tokens. You requested up to 8000 tokens, but can only afford 1000.",
            },
          },
          { status: 402 },
        )
      : chatJson("ok", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  );
  restore = f.restore;
  const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
  const msg = [{ role: "user" as const, content: "hi" }];

  // A guest asks for more output than the operator's credit covers.
  await gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 8000 }).catch(() => undefined);

  // The owner's (or anyone's) ordinary request afterwards must still work.
  const ok = await gw.route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 100 }).then(
    () => "ok",
    (e) => `${e?.status ?? ""} ${e?.code ?? e?.message}`,
  );
  expect(ok).toBe("ok");
});

it("the 402 reaches the guest as a 4xx and the key is not disabled", async () => {
  const f = fakeFetch(() =>
    Response.json(
      {
        error: {
          code: 402,
          message:
            "This request requires more credits, or fewer max_tokens. You requested up to 8000 tokens, but can only afford 1000.",
        },
      },
      { status: 402 },
    ),
  );
  restore = f.restore;
  const { gw } = makeGateway({ strategy: { mode: "single" }, targets: [target("a")] });
  const events: string[] = [];
  gw.onKeyEvent((e) => events.push(e.kind));
  const msg = [{ role: "user" as const, content: "hi" }];
  for (let i = 0; i < 5; i++) {
    const err = await gw
      .route({ metadata: {} } as never, { model: "m", messages: msg, maxTokens: 8000 })
      .catch((e) => e);
    expect(err?.statusCode ?? err?.status).toBe(402);
  }
  expect(events).not.toContain("disabled");
});
