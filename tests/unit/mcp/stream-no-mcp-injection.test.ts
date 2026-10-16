// Regression (N10, was M1): the streaming path has no MCP agentic loop, so it
// must not inject MCP tools — otherwise a client that declared no tools gets
// tool_calls for gateway-only tools it cannot execute.
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import type { GatewayConfig } from "@/config/types";

const SERVER = join(import.meta.dir, "fixtures", "mcp-echo-server.cjs");
const mcpServers = [{ name: "echo", command: "node", args: [SERVER], timeoutSeconds: 5, maxCallDepth: 2, required: false }];

let cleanup: (() => void)[] = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function startUpstream() {
  const bodies: Record<string, unknown>[] = [];
  const events = [
    { id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: "stop" }] },
  ];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json().catch(() => null)) as Record<string, unknown>;
      bodies.push(body);
      if (body?.["stream"]) {
        const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ id: "x", object: "chat.completion", created: 1, model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    },
  });
  return { bodies, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

function gateway(upstreamUrl: string) {
  const cfg = {
    auth: { enabled: false },
    strategy: { mode: "single", targets: ["up"] },
    targets: [{ name: "up", provider: "openai", apiKey: "sk-upstream", baseURL: upstreamUrl, models: ["gpt-4o"] }],
    mcpServers,
  } as unknown as GatewayConfig;
  const gw = new Gateway(cfg);
  return { gw, app: createApp(gw, cfg) };
}

describe("N10 MCP tools on streaming requests", () => {
  it("streaming request without tools is forwarded without MCP tools", async () => {
    const up = startUpstream();
    const { gw, app } = gateway(up.url);
    cleanup.push(up.stop, () => gw.close());
    await gw.initMcp();
    const r = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "x" }] }) });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("[DONE]");
    expect(up.bodies[0]?.["tools"]).toBeUndefined();
  }, 15000);

  it("control: non-streaming request still gets MCP tools injected", async () => {
    const up = startUpstream();
    const { gw, app } = gateway(up.url);
    cleanup.push(up.stop, () => gw.close());
    await gw.initMcp();
    const r = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }) });
    expect(r.status).toBe(200);
    const tools = up.bodies[0]?.["tools"] as { function: { name: string } }[] | undefined;
    expect(tools?.[0]?.function.name).toBe("echo");
  }, 15000);
});
