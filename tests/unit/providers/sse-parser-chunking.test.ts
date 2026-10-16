import { describe, it, expect } from "bun:test";
import { parseSSEStream } from "@/providers/sse-parser";
import { ProviderError } from "@/providers/openai-compat";

// Regression: H13 (parser state lost across reads), EOF flush, mid-stream
// error events, and H10 (early consumer break must cancel the upstream body).

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
}
const ev = (content: string) => JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content } }] });
async function collect(s: ReadableStream<Uint8Array>) { const out: string[] = []; for await (const c of parseSSEStream(s)) out.push(c.choices[0]?.delta.content ?? ""); return out; }

describe("parseSSEStream chunk boundaries", () => {
  it("keeps an event whose blank-line terminator arrives in the next read", async () => {
    expect(await collect(streamOf([`data: ${ev("A")}\n`, `\ndata: ${ev("B")}\n\n`]))).toEqual(["A", "B"]);
  });

  it("keeps multi-line data split across reads", async () => {
    expect(await collect(streamOf([`data: {"id":"1",\n`, `data: "choices":[{"index":0,"delta":{"content":"M"}}]}\n`, `\n`]))).toEqual(["M"]);
  });

  it("flushes the final event at EOF without a trailing blank line", async () => {
    expect(await collect(streamOf([`data: ${ev("A")}\n\ndata: ${ev("B")}\n`]))).toEqual(["A", "B"]);
    expect(await collect(streamOf([`data: ${ev("C")}`]))).toEqual(["C"]);
  });

  it("raises ProviderError on a mid-stream error event", async () => {
    const s = streamOf([`data: ${ev("A")}\n\n`, `data: {"error":{"message":"overloaded"}}\n\n`]);
    const err = await collect(s).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String(err.message)).toContain("overloaded");
  });

  it("cancels the upstream body when the consumer breaks early", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(enc.encode(`data: ${ev("x")}\n\n`)); },
      cancel() { cancelled = true; },
    });
    for await (const _ of parseSSEStream(body)) break;
    expect(cancelled).toBe(true);
  });
});
