import { describe, it, expect } from "bun:test";
import { parseSSEStream } from "@/providers/sse-parser";

const enc = new TextEncoder();
function bytesStream(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i < parts.length) c.enqueue(parts[i++]!); else c.close(); } });
}
async function collect(parts: Uint8Array[]) {
  const out: string[] = [];
  for await (const ch of parseSSEStream(bytesStream(parts))) out.push(ch.choices.map((c) => c.delta?.content ?? "").join("|"));
  return out;
}
const ev = (content: string, nl = "\n") => `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}${nl}${nl}`;

// Seeded PRNG for reproducible fuzzing
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }
function randomSplit(buf: Uint8Array, r: () => number): Uint8Array[] {
  const parts: Uint8Array[] = []; let i = 0;
  while (i < buf.length) { const n = 1 + Math.floor(r() * 7); parts.push(buf.slice(i, i + n)); i += n; }
  return parts;
}

describe("sanity (PASS expected): random byte splits incl. multibyte UTF-8, CRLF, comments, multi-line data", () => {
  it("500 seeded random splits produce identical output", async () => {
    const contents = ["你好", "🌍emoji", "a\nb", "plain", "é\u0301"];
    const raw = ": keepalive\r\n\r\n" + contents.map((c, i) => ev(c, i % 2 ? "\r\n" : "\n")).join("") + "event: message\ndata: [DONE]\n\n";
    const buf = enc.encode(raw);
    const expected = await collect([buf]);
    expect(expected).toEqual(contents);
    const r = rng(42);
    for (let k = 0; k < 500; k++) expect(await collect(randomSplit(buf, r))).toEqual(contents);
  });
});

describe("T3-10 SSE parser robustness bugs", () => {
  it("CR-only line terminators (valid per WHATWG SSE) are parsed", async () => {
    const out = await collect([enc.encode(ev("a", "\r") + ev("b", "\r") + "data: [DONE]\r\r")]);
    expect(out).toEqual(["a", "b"]); // BUG: [] — whole stream silently dropped
  });
  it("a malformed JSON event surfaces an error instead of being silently skipped", async () => {
    const raw = ev("a") + 'data: {"id":"c","choices":[{"index":0,"delta":{"content":"LOST\n\n' + ev("b");
    let err: unknown = null;
    const out: string[] = [];
    try { for await (const ch of parseSSEStream(bytesStream([enc.encode(raw)]))) out.push(ch.choices[0]?.delta?.content ?? ""); } catch (e) { err = e; }
    expect(err !== null || out.length === 3).toBe(true); // BUG: ["a","b"], content silently lost
  });
  it("choices:[null] (known) does not throw TypeError", async () => {
    let err: unknown = null;
    try { await collect([enc.encode('data: {"id":"c","choices":[null]}\n\n')]); } catch (e) { err = e; }
    expect(err === null || (err as Error).name !== "TypeError").toBe(true);
  });
  it("event: error with a non-OpenAI error payload is not swallowed", async () => {
    let err: unknown = null;
    try { await collect([enc.encode(ev("a") + 'event: error\ndata: {"type":"error","message":"overloaded"}\n\n')]); } catch (e) { err = e; }
    expect(err).not.toBeNull(); // BUG: dropped; stream ends "cleanly"
  });
  // Fixed in 2.5: the scan is incremental (O(n)) and one line/event is capped
  // at MAX_SSE_EVENT_CHARS (4 MiB), so an 8 MiB line is rejected quickly
  // instead of blocking the event loop for seconds.
  it("single huge line is O(n): a 3 MiB line in 1 KiB reads parses in < 1s", async () => {
    const payload = "x".repeat(3 * 1024 * 1024);
    const buf = enc.encode(ev(payload) + "data: [DONE]\n\n");
    const parts: Uint8Array[] = [];
    for (let i = 0; i < buf.length; i += 1024) parts.push(buf.slice(i, i + 1024));
    const t0 = performance.now();
    const out = await collect(parts);
    const ms = performance.now() - t0;
    expect(out[0]!.length).toBe(payload.length);
    expect(ms).toBeLessThan(1000);
  }, 120000);
  it("an 8 MiB line (over the 4 MiB cap) is rejected with an error, fast", async () => {
    const buf = enc.encode(ev("x".repeat(8 * 1024 * 1024)));
    const parts: Uint8Array[] = [];
    for (let i = 0; i < buf.length; i += 1024) parts.push(buf.slice(i, i + 1024));
    const t0 = performance.now();
    const err = await collect(parts).then(() => null, (e: unknown) => e);
    expect((err as { code?: string })?.code).toBe("upstream_event_too_large");
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 120000);
});
