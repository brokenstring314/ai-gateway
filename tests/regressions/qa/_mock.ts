/** Minimal in-process OpenAI-compatible upstream for the qa regressions. */
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface QaMock {
  readonly url: string;
  readonly bodies: any[];
  stop(): void;
}

/** model "bad-400" answers an upstream 400. Otherwise streams `chunks` content deltas `gapMs` apart, then finish + [DONE]; non-stream answers JSON. */
export function startQaMock(opts: { chunks?: number; gapMs?: number; model?: string } = {}): QaMock {
  const chunks = opts.chunks ?? 5;
  const gapMs = opts.gapMs ?? 0;
  const model = opts.model ?? "upstream-model-x";
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const body: any = await req.json().catch(() => ({}));
      bodies.push(body);
      if (body.model === "bad-400") {
        return Response.json({ error: { message: "invalid n", type: "invalid_request_error" } }, { status: 400 });
      }
      const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
      if (body.stream) {
        const ev = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: "c1", object: "chat.completion.chunk", created: 1, model };
        let i = 0;
        return new Response(
          new ReadableStream({
            async pull(ctrl) {
              if (i < chunks) {
                if (i > 0 && gapMs) await sleep(gapMs);
                ctrl.enqueue(
                  ev({ ...base, choices: [{ index: 0, delta: { content: `t${i}` }, finish_reason: null }] }),
                );
                i++;
                return;
              }
              ctrl.enqueue(ev({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
              ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
              ctrl.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage,
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, bodies, stop: () => server.stop(true) };
}
