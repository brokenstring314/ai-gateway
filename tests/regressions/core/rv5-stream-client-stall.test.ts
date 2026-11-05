/**
 * Review 2026-11-05 D6 — fixed: a streaming client that stops reading held
 * the upstream connection and the target's concurrency slot until Bun's
 * connection idleTimeout (255 s), and could reopen right away (a
 * maxConcurrency 4 channel was locked by 4 requests). Now a chunk that waits
 * for the client longer than server.streamIdleTimeoutSeconds ends the
 * stream: the upstream is aborted (as a client cancel, never a breaker
 * failure), the slot / permit / reservation are released and the tokens
 * streamed so far are metered. A client that keeps reading is never cut.
 */
import { afterEach, expect, it } from "bun:test";
import net from "node:net";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import type { RequestLogEntry } from "@/observability/request-log";

const enc = new TextEncoder();
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** Endless SSE upstream: one 8 KiB content chunk every `delayMs` (1 ms: as fast as it is read). */
function startUpstream(delayMs = 1) {
  const state = { streams: 0, cancelled: 0, produced: 0 };
  const piece = `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content: "x".repeat(8192) }, finish_reason: null }],
  })}\n\n`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as { stream?: boolean };
      if (!body.stream) {
        return Response.json({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      state.streams++;
      // A never-ending answer.
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(c) {
              await Bun.sleep(delayMs);
              state.produced++;
              c.enqueue(enc.encode(piece));
            },
            cancel() {
              state.cancelled++;
            },
          },
          { highWaterMark: 1 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  stops.push(() => server.stop(true));
  return { port: server.port!, state };
}

it("a client that stops reading is cut after streamIdleTimeoutSeconds: upstream aborted, slot released, usage metered", async () => {
  const up = startUpstream();
  const config = loadConfigFromObject({
    auth: { enabled: false },
    server: { sseHeartbeatSeconds: 0, streamIdleTimeoutSeconds: 1 },
    strategy: { mode: "single", targets: ["a"] },
    targets: [
      {
        name: "a",
        provider: "openai",
        apiKey: "sk-test-a-0123456789",
        baseURL: `http://127.0.0.1:${up.port}/v1`,
        models: ["m"],
        concurrency: { maxConcurrency: 1, queueSize: 0 },
        circuitBreaker: { failureThreshold: 1, timeoutMs: 60_000 },
      },
    ],
  });
  const gw = new Gateway(config);
  const logs: RequestLogEntry[] = [];
  gw.addRequestLogSink((e) => logs.push(e));
  const app = createApp(gw, config);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
  stops.push(() => server.stop(true));

  // Raw socket: read the first bytes, then stop reading (pause) without closing.
  const body = JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
  const sock = net.connect(server.port!, "127.0.0.1", () => {
    sock.write(
      `POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });
  stops.push(() => sock.destroy());
  let firstBytes = "";
  sock.once("data", (d) => {
    firstBytes = d.toString();
    sock.pause();
  });

  // While the stalled stream holds the only slot, another request is refused.
  const deadline0 = Date.now() + 3000;
  while (up.state.streams === 0 && Date.now() < deadline0) await Bun.sleep(20);
  expect(firstBytes).toContain("200");
  const blocked = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  expect(blocked.status).toBe(429);

  // The kernel buffers fill, Bun stops pulling, and 1 s later the stream is given up.
  const deadline = Date.now() + 8000;
  while (up.state.cancelled === 0 && Date.now() < deadline) await Bun.sleep(50);
  expect(up.state.cancelled).toBe(1);
  const producedAtCut = up.state.produced;
  await Bun.sleep(300);
  expect(up.state.produced).toBeLessThanOrEqual(producedAtCut + 1);

  // Slot released; a client stall is not an upstream failure (breaker threshold 1 stays CLOSED).
  const after = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  expect(after.status).toBe(200);
  expect(gw.getCircuitBreakerRegistry().get("a")!.getState()).toBe("CLOSED");

  // The streamed tokens were metered (estimated: the upstream never sent usage).
  const streamLog = logs.find((e) => e.surface === "chat_stream");
  expect(streamLog).toBeDefined();
  expect(streamLog!.tokens?.completion ?? 0).toBeGreaterThan(1000);
  expect(streamLog!.usageEstimated).toBe(true);
}, 20000);

it("a slow client that keeps reading is never cut, even past streamIdleTimeoutSeconds", async () => {
  // ~160 KiB/s upstream (an LLM is far slower), a client reading every 400 ms: the client keeps up, so the
  // gateway is never left with a chunk the client does not take for the 1 s stall limit.
  const up = startUpstream(50);
  const config = loadConfigFromObject({
    auth: { enabled: false },
    server: { sseHeartbeatSeconds: 0, streamIdleTimeoutSeconds: 1 },
    strategy: { mode: "single", targets: ["a"] },
    targets: [
      {
        name: "a",
        provider: "openai",
        apiKey: "sk-test-a-0123456789",
        baseURL: `http://127.0.0.1:${up.port}/v1`,
        models: ["m"],
      },
    ],
  });
  const gw = new Gateway(config);
  const app = createApp(gw, config);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
  stops.push(() => server.stop(true));
  const r = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const reader = r.body!.getReader();
  // Read a chunk every 400 ms for 3 s (well past the 1 s stall limit): reading means not stalled.
  const until = Date.now() + 3000;
  let bytes = 0;
  while (Date.now() < until) {
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    bytes += value?.length ?? 0;
    await Bun.sleep(400);
  }
  expect(bytes).toBeGreaterThan(0);
  expect(up.state.cancelled).toBe(0);
  await reader.cancel();
}, 20000);
