/**
 * Programmable OpenAI-compatible mock upstream for e2e contract tests.
 *
 * Each incoming request takes the next mode from the queue (`enqueue`), or the
 * default mode (`setDefault`) when the queue is empty. Every request is
 * recorded (method, path, headers, parsed body, whether the gateway aborted it)
 * so tests can assert on what the gateway actually sent upstream.
 *
 * The response body is shaped by path: /chat/completions, /completions,
 * /embeddings, /images/generations.
 */

export type Mode =
  | "ok" // JSON success (non-stream) or a normal SSE stream (stream: true)
  | "stream" // force SSE even if the request did not ask for it
  | "stream_usage" // SSE with a trailing usage chunk
  | "tools" // tool call (non-stream) / streamed tool-call deltas
  | "reasoning" // reasoning_content + logprobs in message/deltas
  | "401"
  | "429" // with Retry-After: 7
  | "500"
  | "hang" // never answers; waits for the gateway to abort
  | "hang_after_first" // stream: one chunk, then silence (socket kept open)
  | "garbage_200" // 200 application/json with a non-JSON body
  | "json_on_stream" // stream request answered with 200 application/json chat.completion
  | "done_then_garbage" // [DONE], socket kept open 1.5s, then more data
  | "truncated" // stream: chunks then EOF without finish_reason / [DONE]
  | "empty_stream" // 200 text/event-stream with an empty body
  | "big_stream" // pull-based 64 KiB chunks; `bigStreamProduced` counts what was pulled
  | "rst" // headers then the body errors (connection torn down mid-response)
  | { status: number; body?: unknown; headers?: Record<string, string> };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  /** Set when the gateway aborted the request / cancelled the response body. */
  aborted: boolean;
}

export interface MockUpstream {
  readonly url: string; // base URL incl. /v1
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** Number of big_stream chunks pulled by the gateway so far. */
  readonly bigStreamProduced: number;
  enqueue(...modes: Mode[]): void;
  setDefault(mode: Mode): void;
  reset(): void;
  stop(): void;
}

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const data = (o: unknown) => enc.encode(`data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`);
const DONE = enc.encode("data: [DONE]\n\n");

export const BIG_STREAM_TOTAL = 2000; // x 64 KiB = 125 MiB if fully pulled
export const USAGE = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };

function chunk(
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish, ...extra }],
  };
}

function chatCompletion(
  model: string,
  message: Record<string, unknown>,
  finish = "stop",
  choiceExtra: Record<string, unknown> = {},
) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      { index: 0, message: { role: "assistant", ...message }, finish_reason: finish, logprobs: null, ...choiceExtra },
    ],
    usage: USAGE,
  };
}

const LOGPROBS = { content: [{ token: "ok", logprob: -0.1, bytes: [111, 107], top_logprobs: [] }] };

export function startMockUpstream(name = "mock"): MockUpstream {
  const queue: Mode[] = [];
  let defaultMode: Mode = "ok";
  const requests: RecordedRequest[] = [];
  let bigStreamProduced = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const rec: RecordedRequest = {
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body,
        aborted: false,
      };
      requests.push(rec);
      req.signal.addEventListener("abort", () => {
        rec.aborted = true;
      });
      const mode = queue.length > 0 ? queue.shift()! : defaultMode;
      return respond(mode, url.pathname, body, rec, req.signal);
    },
  });

  function respond(
    mode: Mode,
    path: string,
    body: any,
    rec: RecordedRequest,
    signal: AbortSignal,
  ): Response | Promise<Response> {
    const model = typeof body?.model === "string" ? body.model : "gpt-4o";
    const wantsStream = body?.stream === true;

    if (typeof mode === "object") {
      return new Response(
        mode.body === undefined ? "" : typeof mode.body === "string" ? mode.body : JSON.stringify(mode.body),
        {
          status: mode.status,
          headers: { "content-type": "application/json", ...mode.headers },
        },
      );
    }
    switch (mode) {
      case "401":
        return Response.json(
          {
            error: {
              message: `Incorrect API key provided (${name})`,
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          },
          { status: 401 },
        );
      case "429":
        return Response.json(
          { error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } },
          { status: 429, headers: { "Retry-After": "7" } },
        );
      case "500":
        return Response.json({ error: { message: "upstream exploded", type: "server_error" } }, { status: 500 });
      case "hang":
        return new Promise<Response>((resolve) => {
          signal.addEventListener("abort", () => resolve(new Response("aborted", { status: 499 })));
        });
      case "garbage_200":
        return new Response("not json{", { status: 200, headers: { "content-type": "application/json" } });
      case "json_on_stream":
        return Response.json(chatCompletion(model, { content: "real answer" }));
      case "rst":
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(wantsStream ? "" : '{"id":'));
              c.error(new Error("mock upstream: simulated connection reset"));
            },
          }),
          { status: 200, headers: { "content-type": wantsStream ? "text/event-stream" : "application/json" } },
        );
      case "empty_stream":
        return new Response("", { headers: { "content-type": "text/event-stream" } });
    }

    // Path-shaped success responses.
    if (path.endsWith("/embeddings")) {
      const n = Array.isArray(body?.input) ? body.input.length : 1;
      return Response.json({
        object: "list",
        data: Array.from({ length: n }, (_, i) => ({ object: "embedding", index: i, embedding: [0.1, 0.2, 0.3] })),
        model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      });
    }
    if (path.endsWith("/images/generations")) {
      return Response.json({ created: 1, data: [{ url: `https://img.example/${name}.png`, revised_prompt: "rp" }] });
    }
    if (path.endsWith("/completions") && !path.endsWith("/chat/completions")) {
      return Response.json({
        id: "cmpl-mock",
        object: "text_completion",
        created: 1,
        model,
        choices: [{ index: 0, text: `legacy from ${name}`, finish_reason: "stop", logprobs: null }],
        usage: USAGE,
      });
    }

    const stream = wantsStream || mode === "stream";
    if (!stream) {
      if (mode === "tools") {
        return Response.json(
          chatCompletion(
            model,
            {
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
              ],
            },
            "tool_calls",
          ),
        );
      }
      if (mode === "reasoning") {
        return Response.json(
          chatCompletion(model, { content: "ok", reasoning_content: "think" }, "stop", { logprobs: LOGPROBS }),
        );
      }
      return Response.json(chatCompletion(model, { content: `hello from ${name}` }), {
        headers: { "x-request-id": "upstream-req-1" },
      });
    }

    // ── Streaming ──
    if (mode === "big_stream") {
      const pad = "x".repeat(64 * 1024);
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(c) {
              if (bigStreamProduced >= BIG_STREAM_TOTAL) {
                c.enqueue(DONE);
                c.close();
                return;
              }
              bigStreamProduced++;
              c.enqueue(data(chunk(model, { content: pad })));
            },
            cancel() {
              rec.aborted = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    }

    const events: Uint8Array[] = [];
    let after: ((c: ReadableStreamDefaultController<Uint8Array>) => Promise<void>) | undefined;
    switch (mode) {
      case "tools":
        events.push(
          data(
            chunk(model, {
              role: "assistant",
              content: null,
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
              ],
            }),
          ),
          data(chunk(model, { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] })),
          data(chunk(model, { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] })),
          data(chunk(model, {}, "tool_calls")),
          DONE,
        );
        break;
      case "reasoning":
        events.push(
          data(chunk(model, { role: "assistant", reasoning_content: "thinking..." })),
          data(chunk(model, { content: "ok" }, null, { logprobs: LOGPROBS })),
          data(chunk(model, {}, "stop")),
          DONE,
        );
        break;
      case "hang_after_first":
        events.push(data(chunk(model, { role: "assistant", content: "hel" })));
        after = () => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        break;
      case "done_then_garbage":
        events.push(data(chunk(model, { role: "assistant", content: "ok" }, "stop")), DONE);
        after = async (c) => {
          await sleep(1500);
          c.enqueue(data(chunk(model, { content: "GARBAGE-AFTER-DONE" })));
        };
        break;
      case "truncated":
        events.push(
          data(chunk(model, { role: "assistant", content: "The answer is" })),
          data(chunk(model, { content: " 4" })),
        );
        break;
      default: {
        events.push(
          data(chunk(model, { role: "assistant", content: "Hel" })),
          data(chunk(model, { content: "lo" })),
          data(chunk(model, {}, "stop")),
        );
        if (mode === "stream_usage" || body?.stream_options?.include_usage === true) {
          events.push(
            data({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              created: 1,
              model,
              choices: [],
              usage: USAGE,
            }),
          );
        }
        events.push(DONE);
      }
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(c) {
          for (const e of events) c.enqueue(e);
          if (after) {
            try {
              await after(c);
            } catch {
              /* client gone */
            }
          }
          try {
            c.close();
          } catch {
            /* already cancelled */
          }
        },
        cancel() {
          rec.aborted = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }

  return {
    get url() {
      return `http://127.0.0.1:${server.port}/v1`;
    },
    get port() {
      return server.port as number;
    },
    requests,
    get bigStreamProduced() {
      return bigStreamProduced;
    },
    enqueue(...modes) {
      queue.push(...modes);
    },
    setDefault(mode) {
      defaultMode = mode;
    },
    reset() {
      queue.length = 0;
      requests.length = 0;
      defaultMode = "ok";
      bigStreamProduced = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}
