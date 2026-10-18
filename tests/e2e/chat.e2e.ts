/** Contract: /v1/chat/completions as the official openai SDK sees it. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { baseConfig, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, USAGE, type MockUpstream } from "./harness/mock-upstream";

let up: MockUpstream;
let gw: GatewayProcess;

beforeAll(async () => {
  up = startMockUpstream("a");
  gw = await startGateway({ config: baseConfig([{ name: "a", mock: up }]) });
});
afterAll(async () => {
  await gw?.stop();
  up?.stop();
});
beforeEach(() => up.reset());

const messages = [{ role: "user" as const, content: "hi" }];

describe("chat (openai SDK)", () => {
  it("non-streaming completion: content, usage, wire shape", async () => {
    const r = await gw.client().chat.completions.create({ model: "gpt-4o", messages });
    expect(r.object).toBe("chat.completion");
    expect(r.choices[0]!.message.content).toBe("hello from a");
    expect(r.choices[0]!.finish_reason).toBe("stop");
    expect(r.usage?.total_tokens).toBe(USAGE.total_tokens);
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0]!.headers["authorization"]).toBe("Bearer sk-upstream-a");
  });

  it("streaming with include_usage: deltas assemble, usage chunk arrives", async () => {
    const s = await gw
      .client()
      .chat.completions.create({ model: "gpt-4o", messages, stream: true, stream_options: { include_usage: true } });
    let text = "";
    let usage: unknown;
    let finish: string | null = null;
    for await (const ch of s) {
      text += ch.choices[0]?.delta?.content ?? "";
      finish = ch.choices[0]?.finish_reason ?? finish;
      if (ch.usage) usage = ch.usage;
    }
    expect(text).toBe("Hello");
    expect(finish).toBe("stop");
    expect(usage).toMatchObject({ total_tokens: USAGE.total_tokens });
  });

  it("streamed tool calls assemble via finalChatCompletion()", async () => {
    up.enqueue("tools");
    const runner = gw.client().chat.completions.stream({
      model: "gpt-4o",
      messages,
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
        },
      ],
    });
    const final = await runner.finalChatCompletion();
    const call = final.choices[0]!.message.tool_calls?.[0];
    expect(final.choices[0]!.finish_reason).toBe("tool_calls");
    expect(call?.type).toBe("function");
    expect(call && "function" in call ? call.function.name : undefined).toBe("get_weather");
    expect(call && "function" in call ? JSON.parse(call.function.arguments) : undefined).toEqual({ city: "SF" });
  });

  // T3-11 (fixed in 2.6): reasoning_content / logprobs pass through.
  it("reasoning_content and logprobs pass through (non-stream)", async () => {
    up.enqueue("reasoning");
    const r: any = await gw.client().chat.completions.create({ model: "gpt-4o", messages, logprobs: true });
    expect(r.choices[0].message.reasoning_content).toBe("think");
    expect(r.choices[0].logprobs?.content?.[0]?.token).toBe("ok");
  });

  it("reasoning_content and logprobs pass through (stream)", async () => {
    up.enqueue("reasoning");
    const s = await gw.client().chat.completions.create({ model: "gpt-4o", messages, stream: true, logprobs: true });
    let reasoning = "";
    let sawLogprobs = false;
    for await (const ch of s as AsyncIterable<any>) {
      reasoning += ch.choices[0]?.delta?.reasoning_content ?? "";
      if (ch.choices[0]?.logprobs?.content?.length) sawLogprobs = true;
    }
    expect(reasoning).toBe("thinking...");
    expect(sawLogprobs).toBe(true);
  });
});
