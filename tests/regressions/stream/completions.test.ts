import { describe, it, expect } from "bun:test";
import { setup, sse, chunk, post } from "./_h";

describe("T3-7 /v1/completions drops snake_case params (max_tokens, top_p, ...) and answers in chat/camelCase shape", () => {
  it("max_tokens / top_p / presence_penalty reach upstream", async () => {
    const s = setup(() =>
      Response.json({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "length" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    try {
      const r = await post(
        s.app,
        { prompt: "hi", messages: undefined, max_tokens: 5, top_p: 0.5, presence_penalty: 1 },
        "/v1/completions",
      );
      expect(r.status).toBe(200);
      const up = s.seen[0]!;
      expect(up["max_tokens"]).toBe(5); // BUG: undefined -> upstream default length, max-token plugin can't cap it either
      expect(up["top_p"]).toBe(0.5);
    } finally {
      s.stop();
    }
  });
  it("response is an OpenAI text_completion (choices[].text, finish_reason, usage.prompt_tokens)", async () => {
    const s = setup(() =>
      Response.json({
        id: "x",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    try {
      const r = await post(s.app, { prompt: "hi", messages: undefined }, "/v1/completions");
      const j = (await r.json()) as any;
      console.log(JSON.stringify(j));
      expect(j.choices[0].text).toBe("ok");
      expect(j.choices[0].finish_reason).toBe("stop");
      expect(j.usage.prompt_tokens).toBe(1);
    } finally {
      s.stop();
    }
  });
  it("stream chunks are wire format (choices[].text / finish_reason), not internal camelCase", async () => {
    const s = setup(() => sse([chunk("ok", "stop"), "data: [DONE]\n\n"]));
    try {
      const r = await post(s.app, { prompt: "hi", messages: undefined, stream: true }, "/v1/completions");
      const t = await r.text();
      console.log(t);
      expect(t).not.toContain("finishReason");
    } finally {
      s.stop();
    }
  });
});
