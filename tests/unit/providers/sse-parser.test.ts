/**
 * Unit tests for the SSE stream parser.
 */
import { describe, it, expect } from "bun:test";
import { parseSSEStream } from "@/providers/sse-parser";
import type { StreamChunk } from "@/providers/types";

/** Helper: create a ReadableStream from a string and collect all parsed chunks. */
async function collectStreamChunks(input: string, signal?: AbortSignal): Promise<StreamChunk[]> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const chunks: StreamChunk[] = [];
  for await (const chunk of parseSSEStream(stream, signal)) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Helper: create a ReadableStream that yields bytes in multiple chunks. */
async function collectFromChunks(
  chunks: string[],
  signal?: AbortSignal,
): Promise<StreamChunk[]> {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks.length === 0) {
        if (!closed) {
          controller.close();
          closed = true;
        }
        return;
      }
      controller.enqueue(encoder.encode(chunks.shift()!));
    },
  });

  const result: StreamChunk[] = [];
  for await (const chunk of parseSSEStream(stream, signal)) {
    result.push(chunk);
  }
  return result;
}

describe("parseSSEStream", () => {
  it("parses a single SSE event", async () => {
    const input = [
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("chat-1");
    expect(chunks[0]!.model).toBe("gpt-4");
    expect(chunks[0]!.choices[0]?.delta?.content).toBe("Hello");
  });

  it("handles [DONE] sentinel", async () => {
    const input = [
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n',
      "\n",
      "data: [DONE]\n",
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.choices[0]?.delta?.content).toBe("Hi");
  });

  it("skips comment lines", async () => {
    const input = [
      ": this is a comment\n",
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    expect(chunks).toHaveLength(1);
  });

  it("handles multiple SSE events", async () => {
    const input = [
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
      "\n",
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n',
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.choices[0]?.delta?.content).toBe("Hello");
    expect(chunks[1]!.choices[0]?.delta?.content).toBe(" world");
    expect(chunks[1]!.choices[0]?.finishReason).toBe("stop");
  });

  it("handles partial reads across chunks", async () => {
    const part1 = 'data: {"id":"chat-1","object":"chat.com';
    const part2 = 'pletion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n';

    const chunks = await collectFromChunks([part1, part2]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.choices[0]?.delta?.content).toBe("Hello");
  });

  it("handles partial lines across chunks", async () => {
    const part1 = 'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"He';
    const part2 = 'llo"},"finish_reason":null}]}\n\n';

    const chunks = await collectFromChunks([part1, part2]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.choices[0]?.delta?.content).toBe("Hello");
  });

  it("handles multi-byte UTF-8 characters split across chunks", async () => {
    // U+1F600 (😀) is a 4-byte UTF-8 sequence: F0 9F 98 80
    const encoder = new TextEncoder();
    const smile = "😀";
    const bytes = encoder.encode(smile);

    const prefix = encoder.encode(
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"',
    );
    const suffix = encoder.encode(
      '"},"finish_reason":null}]}\n\n',
    );

    // Split the 4-byte character between two chunks.
    const chunk1 = new Uint8Array(prefix.length + 2);
    chunk1.set(prefix);
    chunk1.set(bytes.subarray(0, 2), prefix.length);

    const chunk2 = new Uint8Array(bytes.length - 2 + suffix.length);
    chunk2.set(bytes.subarray(2));
    chunk2.set(suffix, bytes.length - 2);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      },
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of parseSSEStream(stream)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.choices[0]?.delta?.content).toBe(smile);
  });

  it("aborts on signal", async () => {
    const controller = new AbortController();
    const input = [
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
      "\n",
    ].join("");

    controller.abort();
    const chunks = await collectStreamChunks(input, controller.signal);
    expect(chunks).toHaveLength(0);
  });

  it("normalizes finish_reason values", async () => {
    const input = [
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"model_length"}]}\n',
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    expect(chunks[0]!.choices[0]?.finishReason).toBe("length");
  });

  it("handles events with usage data", async () => {
    const input = [
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n',
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    expect(chunks[0]!.usage).toBeDefined();
    expect(chunks[0]!.usage!.promptTokens).toBe(10);
    expect(chunks[0]!.usage!.completionTokens).toBe(5);
  });

  it("gracefully handles malformed JSON", async () => {
    const input = [
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n',
      "\n",
      "data: {not valid json}\n",
      "\n",
      'data: {"id":"chat-2","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"still works"},"finish_reason":"stop"}]}\n',
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    // First and third events should parse, second (malformed) is skipped.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.choices[0]?.delta?.content).toBe("ok");
    expect(chunks[1]!.choices[0]?.delta?.content).toBe("still works");
  });

  it("handles the legacy completions delta format (no role)", async () => {
    const input = [
      'data: {"id":"legacy-1","object":"text_completion","created":1234,"model":"gpt-3.5","choices":[{"index":0,"delta":{"content":"text"},"finish_reason":null}]}\n',
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    expect(chunks[0]!.choices[0]?.delta?.role).toBe("assistant");
    expect(chunks[0]!.choices[0]?.delta?.content).toBe("text");
  });

  it("handles tool_calls in delta", async () => {
    const input = [
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1234,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}]},"finish_reason":null}]}\n',
      "\n",
    ].join("");

    const chunks = await collectStreamChunks(input);
    const toolCalls = chunks[0]!.choices[0]?.delta?.toolCalls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls![0]!.id).toBe("call_1");
    expect(toolCalls![0]!.function.name).toBe("get_weather");
    expect(toolCalls![0]!.function.arguments).toBe('{"city":"NYC"}');
  });

  it("passes through an empty stream without error", async () => {
    const chunks = await collectStreamChunks("");
    expect(chunks).toHaveLength(0);
  });
});
