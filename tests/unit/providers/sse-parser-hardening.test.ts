/** SSE parser hardening (PR 2.5: T3-3, T3-4, T3-5, T3-10). */
import { describe, it, expect } from "bun:test";
import { chunkFromJsonBody, parseSSEStream, ReadableStreamError, SSEParser } from "@/providers/sse-parser";
import { ProviderError } from "@/providers/openai-compat";

const enc = new TextEncoder();
const ev = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}`;

function streamOf(parts: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < parts.length) c.enqueue(enc.encode(parts[i++]!));
      else c.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of parseSSEStream(s)) out.push(c.choices.map((x) => x.delta.content ?? "").join("|"));
  return out;
}

describe("line endings", () => {
  it("\\r\\n split across two reads is one terminator, not two", async () => {
    // If the \r and \n were taken as two line ends, the empty line between
    // them would dispatch the first data line on its own.
    const out = await collect(streamOf([`data: {"id":"c",\r`, `\ndata: "choices":[{"index":0,"delta":{"content":"M"},"finish_reason":"stop"}]}\r\n\r\n`]));
    expect(out).toEqual(["M"]);
  });

  it("mixed \\r, \\n and \\r\\n terminators", async () => {
    const out = await collect(streamOf([`${ev("a")}\r\r${ev("b")}\n\n${ev("c")}\r\n\r\ndata: [DONE]\r`]));
    expect(out).toEqual(["a", "b", "c"]);
  });
});

describe("[DONE]", () => {
  it("ends the stream at once, ignores later data and cancels the upstream body", async () => {
    let cancelled = false;
    const out = await collect(streamOf([`${ev("a")}\n\ndata: [DONE]\n\n${ev("AFTER")}\n\n`, `${ev("LATER")}\n\n`], () => { cancelled = true; }));
    expect(out).toEqual(["a"]);
    expect(cancelled).toBe(true);
  });
});

describe("truncation", () => {
  it("EOF after content without finish_reason or [DONE] is a truncated-stream error", async () => {
    const out: string[] = [];
    let err: unknown;
    try {
      for await (const c of parseSSEStream(streamOf([`${ev("The answer is")}\n\n`]))) out.push(c.choices[0]!.delta.content!);
    } catch (e) {
      err = e;
    }
    expect(out).toEqual(["The answer is"]);
    expect(err).toBeInstanceOf(ReadableStreamError);
    expect((err as ReadableStreamError).code).toBe("upstream_stream_truncated");
  });

  it("EOF after a finish_reason (no [DONE]) is a complete stream", async () => {
    expect(await collect(streamOf([`${ev("x", "stop")}\n\n`]))).toEqual(["x"]);
  });
});

describe("events", () => {
  it("event: error with a plain-text payload is an upstream error", async () => {
    const err = await collect(streamOf([`${ev("a")}\n\nevent: error\ndata: overloaded\n\n`])).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain("overloaded");
  });

  it("non-object choices / tool_calls entries are ignored, not a TypeError", async () => {
    const raw = `data: {"id":"c","choices":[null,1,{"index":0,"delta":{"content":"ok","tool_calls":[null]},"finish_reason":"stop"}]}\n\n`;
    expect(await collect(streamOf([raw]))).toEqual(["ok"]);
  });

  it("an event whose data lines together exceed the cap is rejected", () => {
    const p = new SSEParser();
    const line = `data: ${"y".repeat(1024 * 1024)}\n`;
    expect(() => { for (let i = 0; i < 5; i++) p.feed(line); }).toThrow(ReadableStreamError);
  });
});

describe("chunkFromJsonBody (200 JSON on a stream request)", () => {
  it("chat.completion becomes one complete chunk", () => {
    const c = chunkFromJsonBody(JSON.stringify({ id: "x", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "real answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    expect(c.object).toBe("chat.completion.chunk");
    expect(c.choices[0]!.delta.content).toBe("real answer");
    expect(c.choices[0]!.finishReason).toBe("stop");
    expect(c.usage?.totalTokens).toBe(3);
  });

  it("an error body is an upstream ProviderError (502)", () => {
    expect(() => chunkFromJsonBody(JSON.stringify({ error: { message: "model overloaded" } }))).toThrow(ProviderError);
  });

  it("anything else is an invalid response", () => {
    expect(() => chunkFromJsonBody("<html>")).toThrow(ReadableStreamError);
    expect(() => chunkFromJsonBody(JSON.stringify({ ok: true }))).toThrow(ReadableStreamError);
  });
});
