import { describe, it, expect } from "bun:test";
import { parseSSEStream } from "@/providers/sse-parser";
import { createOpenAIWireStreamSerializer } from "@/handlers/openai-wire";

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

function chunk(toolCalls: unknown[]) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
  };
}

// Parallel tool calls stream as interleaved deltas, each carrying a single call
// addressed by `index`. Losing the index makes every fragment look like call 0.
const events = [
  chunk([{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }]),
  chunk([{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "" } }]),
  chunk([{ index: 1, function: { arguments: '{"tz":"UTC"}' } }]),
  chunk([{ index: 0, function: { arguments: '{"city":"SF"}' } }]),
];

describe("streaming tool-call index", () => {
  it("parser keeps the upstream tool_call index on every delta", async () => {
    const idx: number[] = [];
    for await (const c of parseSSEStream(sse(events))) {
      for (const tc of c.choices[0]?.delta?.toolCalls ?? []) idx.push(tc.index ?? -1);
    }
    expect(idx).toEqual([0, 1, 1, 0]);
  });

  it("wire serializer emits the upstream index so clients reassemble calls correctly", async () => {
    const serialize = createOpenAIWireStreamSerializer();
    const args: Record<number, string> = {};
    const names: Record<number, string> = {};
    for await (const c of parseSSEStream(sse(events))) {
      const wire = serialize(c) as {
        choices: { delta: { tool_calls?: { index: number; function: { name?: string; arguments: string } }[] } }[];
      };
      for (const tc of wire.choices[0]?.delta.tool_calls ?? []) {
        args[tc.index] = (args[tc.index] ?? "") + tc.function.arguments;
        if (tc.function.name) names[tc.index] = tc.function.name;
      }
    }
    expect(names).toEqual({ 0: "get_weather", 1: "get_time" });
    expect(args).toEqual({ 0: '{"city":"SF"}', 1: '{"tz":"UTC"}' });
  });
});
