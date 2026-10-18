// Shared harness: mock OpenAI upstream + gateway served over HTTP + official `openai` SDK client.
import OpenAI from "openai";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import type { GatewayConfig } from "@/config/types";

export interface Upstream {
  bodies: any[];
  url: string;
  stop(): void;
}

/** Start a mock upstream; `handler` gets the parsed JSON body + path and returns a Response. */
export function startUpstream(handler: (body: any, path: string) => Response | Promise<Response>): Upstream {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json().catch(() => null);
      bodies.push(body);
      return handler(body, new URL(req.url).pathname);
    },
  });
  return { bodies, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

export function sse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

export function startGateway(upstreamUrl: string, extra: Partial<GatewayConfig> = {}) {
  const cfg = {
    auth: { enabled: false },
    strategy: { mode: "single", targets: ["up"] },
    targets: [{ name: "up", provider: "openai", apiKey: "sk-upstream", baseURL: upstreamUrl, models: ["gpt-4o", "text-embedding-3-small", "dall-e-3"] }],
    ...extra,
  } as unknown as GatewayConfig;
  const gw = new Gateway(cfg);
  const app = createApp(gw, cfg);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  const client = new OpenAI({ apiKey: "client-key", baseURL: `http://127.0.0.1:${server.port}/v1`, maxRetries: 0 });
  return { gw, app, client, base: `http://127.0.0.1:${server.port}`, stop: () => { server.stop(true); gw.close(); } };
}

export const completion = (message: any, extra: any = {}) => ({
  id: "chatcmpl-1", object: "chat.completion", created: 1, model: "gpt-4o",
  choices: [{ index: 0, message, finish_reason: "stop", logprobs: null, ...extra }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});
