/**
 * Browser e2e server: the real gateway bootstrap (same path as
 * `ai-gateway serve`) with an in-process fake OpenAI-compatible upstream.
 *
 * Usage: bun tests/browser/support/server.ts <config.json> <port> <dataDir>
 *
 * Channels created through the console are subject to the public-only SSRF
 * guard. The guard is left as it is; the harness only (a) maps host names
 * under `.upstream.test` to a public address through the
 * embedder-only `hostResolver` override, and (b) answers fetches to those
 * names in-process, so no private address is ever configured or contacted.
 *
 * Fake upstream behaviour, by model name:
 *  - content is "<host label>:<model>" (e.g. "alpha:fake-chat"), usage 11 / 22;
 *  - a model containing "slow" streams 40 chunks "tick<i> " 150 ms apart
 *    (Playground stop, config change during an in-flight stream);
 *  - GET /models lists fake-chat, fake-slow, fake-extra.
 */
import { bootstrap } from "../../../src/server/bootstrap.ts";
import { systemResolver } from "../../../src/security/url-guard.ts";

const [configPath, portArg, dataDir] = process.argv.slice(2);
if (!configPath || !portArg || !dataDir) {
  console.error("usage: server.ts <config.json> <port> <dataDir>");
  process.exit(2);
}

const FAKE_SUFFIX = ".upstream.test";
const PUBLIC_IP = "93.184.216.34";
const enc = new TextEncoder();
const original = globalThis.fetch;

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) {
  const o: Record<string, unknown> = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) o["usage"] = usage;
  return enc.encode(`data: ${JSON.stringify(o)}\n\n`);
}

/** fake-slow: 40 chunks, 150 ms apart (~6 s). */
const SLOW_TICKS = 40;
const USAGE = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };

async function answer(url: URL, init?: RequestInit): Promise<Response> {
  const label = url.hostname.slice(0, -FAKE_SUFFIX.length).split(".")[0] ?? "fake";
  if (url.pathname.endsWith("/models")) {
    return Response.json({
      object: "list",
      data: ["fake-chat", "fake-slow", "fake-extra"].map((id) => ({ id, object: "model", owned_by: label })),
    });
  }
  let body: { model?: string; stream?: boolean } = {};
  try {
    body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  } catch {
    // not JSON
  }
  const model = String(body.model ?? "");
  const content = `${label}:${model}`;
  if (!url.pathname.endsWith("/chat/completions")) {
    return Response.json({ error: { message: "not found", type: "invalid_request_error" } }, { status: 404 });
  }
  if (body.stream !== true) {
    return Response.json({
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: USAGE,
    });
  }
  const slow = model.includes("slow");
  const signal = init?.signal ?? undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        ctrl.enqueue(chunk(model, { role: "assistant", content: "" }));
        if (slow) {
          for (let i = 0; i < SLOW_TICKS; i++) {
            if (signal?.aborted) return;
            ctrl.enqueue(chunk(model, { content: `tick${i} ` }));
            await Bun.sleep(150);
          }
        } else {
          ctrl.enqueue(chunk(model, { content }));
        }
        ctrl.enqueue(chunk(model, {}, "stop"));
        ctrl.enqueue(chunk(model, {}, null, USAGE));
        ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
        ctrl.close();
      } catch {
        // cancelled by the gateway
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // A public-policy channel's request is pinned to the checked IP (RA3), the name is in the Host header.
  const host = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("host");
  if (host && url.hostname === PUBLIC_IP) url.host = host;
  if (!url.hostname.endsWith(FAKE_SUFFIX)) return original(input as never, init);
  return answer(url, init);
}) as typeof fetch;

await bootstrap(configPath, {
  port: Number(portArg),
  host: "127.0.0.1",
  dataDir,
  hostResolver: async (host) => (host.endsWith(FAKE_SUFFIX) ? [PUBLIC_IP] : systemResolver(host)),
});
