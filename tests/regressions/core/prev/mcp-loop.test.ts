// M2/M3: MCP agentic loop wire behaviour (M1 streaming tool injection is fixed and covered in tests/unit/mcp).
import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { startUpstream, startGateway, completion } from "./harness";
import { getRequestLogger } from "@/observability/request-log";

const SERVER = join(import.meta.dir, "mcp-echo-server.cjs");
const mcpServers = [{ name: "echo", command: "node", args: [SERVER], timeoutSeconds: 5, maxCallDepth: 2, required: false }];

let cleanup: (() => void)[] = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

const toolCallMsg = (id: string) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "echo", arguments: "{\"text\":\"a\"}" } }] });

describe("MCP loop", () => {
  it.failing("M2 depth exceeded: OpenAI-shaped error with a meaningful message, and the failure is request-logged", async () => {
    const up = startUpstream(() => Response.json(completion(toolCallMsg("call_" + Math.random()), { finish_reason: "tool_calls" })));
    const gw = startGateway(up.url, { mcpServers } as any); cleanup.push(up.stop, gw.stop);
    await gw.gw.initMcp();
    const spy = spyOn(getRequestLogger(), "logRequest");
    const r = await fetch(`${gw.base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "loop" }] }) });
    const j: any = await r.json();
    spy.mockRestore(); console.log("M2 status", r.status, JSON.stringify(j));
    expect(up.bodies.length).toBe(3); // initial + maxCallDepth(2) loop rounds
    expect(spy.mock.calls.some((c: any[]) => c[0]?.error)).toBe(true); // currently never logged
    expect(j.error.message).toMatch(/depth/i); // currently "Internal server error" (500)
  }, 15000);

  it.failing("M3 usage: the response usage covers every upstream call made by the loop", async () => {
    let n = 0;
    const up = startUpstream(() => Response.json(n++ === 0
      ? completion(toolCallMsg("call_1"), { finish_reason: "tool_calls" })
      : completion({ role: "assistant", content: "done" })));
    const gw = startGateway(up.url, { mcpServers } as any); cleanup.push(up.stop, gw.stop);
    await gw.gw.initMcp();
    const r = await gw.client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] });
    expect(r.choices[0]!.message.content).toBe("done");
    expect(up.bodies.length).toBe(2);
    expect(r.usage!.total_tokens).toBe(10); // 2 upstream calls x 5 tokens; gateway reports only the last (5)
  }, 15000);
});
