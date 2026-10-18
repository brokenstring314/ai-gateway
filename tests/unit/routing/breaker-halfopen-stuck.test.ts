import { describe, it, expect } from "bun:test";
import { Gateway } from "@/gateway";
import type { GatewayConfig } from "@/config/types";
import type { StreamChunk } from "@/providers/types";

// S1: a HALF_OPEN probe that ends in AbortError (client abort OR the gateway's own
// request timeout) or ConcurrencyLimitError records nothing, so the single probe
// permit is consumed forever: the breaker stays HALF_OPEN with 0 permits and the
// target returns 503 permanently (until config reload / restart).

const req = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };
const resp = {
  id: "x",
  object: "chat.completion",
  created: 0,
  model: "m",
  provider: "a",
  choices: [{ index: 0, message: { role: "assistant" as const, content: "ok" }, finishReason: "stop" }],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};
const chunk: StreamChunk = {
  id: "1",
  object: "chat.completion.chunk",
  created: 0,
  model: "m",
  choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finishReason: "" }],
};
const tgt = (extra: any = {}) => ({
  name: "a",
  provider: "openai",
  apiKey: "k",
  baseURL: "http://127.0.0.1:1/v1",
  circuitBreaker: { failureThreshold: 1, timeoutMs: 50 },
  ...extra,
});

function setup(extra: any = {}) {
  const g = new Gateway({
    strategy: { mode: "single", targets: ["a"] },
    targets: [tgt(extra)],
  } as any as GatewayConfig);
  let mode: "fail" | "abort" | "ok" | "hang" = "fail";
  const p: any = { name: "a", supportedModels: () => [], supportsModel: () => true, models: () => [] };
  p.complete = async (ctx: any) => {
    if (mode === "fail") throw new Error("down");
    if (mode === "abort") throw new DOMException("Aborted", "AbortError");
    if (mode === "hang") {
      await new Promise((_, rej) =>
        ctx.signal.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError"))),
      );
    }
    return resp;
  };
  p.completeStream = async function* () {
    if (mode === "abort") throw new DOMException("Aborted", "AbortError");
    yield chunk;
  };
  g.registerProvider(p);
  return {
    g,
    set: (m: typeof mode) => {
      mode = m;
    },
  };
}

describe("S1 breaker HALF_OPEN probe slot leak", () => {
  it("non-stream: aborted probe leaves target 503 forever", async () => {
    const { g, set } = setup();
    await g.route({} as any, req).catch(() => {}); // trip -> OPEN
    await Bun.sleep(70); // -> HALF_OPEN on next allow()
    set("abort");
    await g.route({} as any, req).catch(() => {}); // probe aborted (client left)
    set("ok");
    await Bun.sleep(200); // well past timeoutMs
    const r = await g.route({} as any, req).then(
      () => "ok",
      (e) => e.statusCode,
    );
    expect(r).toBe("ok");
  });

  it("non-stream: probe killed by gateway request timeout (hung upstream) -> stuck", async () => {
    const { g, set } = setup();
    await g.route({} as any, req).catch(() => {});
    await Bun.sleep(70);
    set("hang");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20); // request-timeout middleware
    await g.route({ signal: ac.signal } as any, req).catch(() => {});
    set("ok");
    await Bun.sleep(200);
    const r = await g.route({} as any, req).then(
      () => "ok",
      (e) => e.statusCode,
    );
    expect(r).toBe("ok");
  });

  it("stream: aborted probe leaves target 503 forever", async () => {
    const { g, set } = setup();
    await g.route({} as any, req).catch(() => {});
    await Bun.sleep(70);
    set("abort");
    const drain = async () => {
      for await (const _ of g.routeStream({} as any, req)) {
      }
    };
    await drain().catch(() => {});
    set("ok");
    await Bun.sleep(200);
    const r = await drain().then(
      () => "ok",
      (e) => e.statusCode,
    );
    expect(r).toBe("ok");
  });
});
