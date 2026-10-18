// Shared helpers for SSE stream regression tests: mock upstream via Bun.serve + gateway app.
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import type { GatewayConfig } from "@/config/types";

export type Handler = (req: Request) => Response | Promise<Response>;

/** Start a mock upstream (OpenAI-compatible) and a gateway app pointing at it. */
export function setup(handler: Handler, extra: Partial<GatewayConfig> = {}, target: Record<string, unknown> = {}) {
  const seen: Record<string, unknown>[] = [];
  const up = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(req) {
      try { seen.push(JSON.parse(await req.clone().text())); } catch { /* */ }
      return handler(req);
    },
  });
  const config = {
    strategy: { mode: "single", targets: ["up"] },
    targets: [{ name: "up", provider: "openai", apiKey: "sk", baseURL: `http://127.0.0.1:${up.port}/v1`, models: ["gpt-4o"], ...target }],
    ...extra,
  } as GatewayConfig;
  const gw = new Gateway(config);
  const app = createApp(gw, config);
  return { up, app, gw, seen, config, stop: () => up.stop(true) };
}

export function sse(events: string[], headers: Record<string, string> = {}): Response {
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream", ...headers } });
}

export const chunk = (content: string, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { content }, finish_reason: finish }], ...extra })}\n\n`;

export function post(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, body: Record<string, unknown>, path = "/v1/chat/completions") {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], ...body }) });
}

/** Read an SSE body for at most `ms`, returning text read so far and whether it ended. */
export async function readFor(res: Response, ms: number): Promise<{ text: string; ended: boolean }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (true) {
    const left = deadline - Date.now();
    if (left <= 0) { await reader.cancel().catch(() => {}); return { text, ended: false }; }
    const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => "timeout" as const)]);
    if (r === "timeout") { await reader.cancel().catch(() => {}); return { text, ended: false }; }
    if (r.done) return { text, ended: true };
    text += dec.decode(r.value, { stream: true });
  }
}
