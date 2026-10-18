// Differential sanity checks that currently PASS (documented so regressions are caught).
import { describe, it, expect } from "bun:test";
import { setup, sse, post } from "./_h";

const c = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices, ...extra })}\n\n`;

describe("sanity: parallel tool_call deltas, n>1, include_usage, heartbeat placement", () => {
  it("interleaved tool_call deltas keep index/id/name/arguments; n=2 role once per choice; usage chunk forwarded", async () => {
    const s = setup(() =>
      sse([
        c([
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "fa", arguments: "" } }],
            },
            finish_reason: null,
          },
        ]),
        c([
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "fb", arguments: '{"y"' } }],
            },
            finish_reason: null,
          },
        ]),
        c([
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] }, finish_reason: null },
        ]),
        c([
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: ":2}" } }] },
            finish_reason: "tool_calls",
          },
        ]),
        c([{ index: 1, delta: { role: "assistant", content: "second" }, finish_reason: "stop" }]),
        c([], { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
        "data: [DONE]\n\n",
      ]),
    );
    try {
      const t = await (await post(s.app, { stream: true, n: 2, stream_options: { include_usage: true } })).text();
      const evs = t
        .split("\n\n")
        .filter((l) => l.startsWith("data: {"))
        .map((l) => JSON.parse(l.slice(6)));
      const calls: Record<number, { id?: string; name?: string; args: string }> = {};
      for (const e of evs)
        for (const ch of e.choices)
          for (const tc of ch.delta.tool_calls ?? []) {
            const cur = (calls[tc.index] ??= { args: "" });
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            cur.args += tc.function?.arguments ?? "";
          }
      expect(calls).toEqual({
        0: { id: "call_a", name: "fa", args: '{"x":1}' },
        1: { id: "call_b", name: "fb", args: '{"y":2}' },
      });
      expect(evs.filter((e) => e.choices.some((ch: any) => ch.delta.role)).length).toBe(2);
      expect(evs.at(-1).usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
      expect(t.endsWith("data: [DONE]\n\n")).toBe(true);
    } finally {
      s.stop();
    }
  });
});
