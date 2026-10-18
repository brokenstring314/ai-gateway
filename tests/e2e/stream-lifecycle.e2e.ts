/** Contract: SSE stream lifecycle over a real socket (cancel, [DONE], truncation, idle timeout, backpressure). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { baseConfig, postJson, readFor, startGateway, type GatewayProcess } from "./harness/gateway";
import { BIG_STREAM_TOTAL, startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

let up: MockUpstream;
let gw: GatewayProcess;

beforeAll(async () => {
  up = startMockUpstream("a");
  gw = await startGateway({
    config: baseConfig([{ name: "a", mock: up }], { server: { sseHeartbeatSeconds: 0, streamIdleTimeoutSeconds: 1 } }),
  });
});
afterAll(async () => {
  await gw?.stop();
  up?.stop();
});
beforeEach(() => up.reset());

const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true };

describe("stream lifecycle", () => {
  it("client cancel (SDK abort) aborts the upstream request", async () => {
    up.enqueue("hang_after_first");
    const ac = new AbortController();
    const s = await gw.client().chat.completions.create(body as never, { signal: ac.signal });
    const iter = (s as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    await iter.next();
    ac.abort();
    await iter.next().catch(() => {});
    const deadline = Date.now() + 3000;
    while (!up.requests[0]?.aborted && Date.now() < deadline) await Bun.sleep(25);
    expect(up.requests[0]?.aborted).toBe(true);
  });

  // T3-3 (open): the gateway waits for upstream EOF after [DONE] and forwards post-[DONE] data.
  it("[DONE] ends the client stream immediately", async () => {
    up.enqueue("done_then_garbage");
    const t0 = Date.now();
    const r = await postJson(gw, "/v1/chat/completions", body);
    const { text, ended } = await readFor(r, 3000);
    expect(text).toContain("[DONE]");
    expect(text).not.toContain("GARBAGE-AFTER-DONE");
    expect(ended).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  // T3-4 (open): EOF without finish_reason/[DONE] is reported as a clean completion.
  it("truncated upstream stream ends with an error event, not [DONE]", async () => {
    up.enqueue("truncated");
    const r = await postJson(gw, "/v1/chat/completions", body);
    const { text } = await readFor(r, 3000);
    expect(text).toContain("error");
    expect(text).not.toContain("[DONE]");
  });

  it("silent upstream ends the stream after streamIdleTimeoutSeconds with an error event", async () => {
    up.enqueue("hang_after_first");
    const r = await postJson(gw, "/v1/chat/completions", body);
    const { text, ended } = await readFor(r, 5000);
    expect(ended).toBe(true);
    expect(text).toContain("hel");
    expect(text).toContain("stream_idle_timeout");
    expect(text).not.toContain("[DONE]");
    await Bun.sleep(100);
    expect(up.requests[0]?.aborted).toBe(true);
  }, 10000);

  it("a client that reads nothing: upstream pulling plateaus (memory bounded)", async () => {
    up.enqueue("big_stream");
    const r = await postJson(gw, "/v1/chat/completions", body);
    await Bun.sleep(1500);
    const first = up.bigStreamProduced;
    await Bun.sleep(1000);
    const second = up.bigStreamProduced;
    await r.body?.cancel();
    // Socket + stream buffers hold a bounded amount (a few hundred 64 KiB chunks); it must stop growing.
    expect(second).toBe(first);
    expect(second).toBeLessThan(BIG_STREAM_TOTAL / 2);
  }, 10000);

  // T3-5 (open): a non-SSE 200 on a stream request becomes an empty successful stream.
  it("200 application/json on a stream request is not turned into an empty stream", async () => {
    up.enqueue("json_on_stream");
    const r = await postJson(gw, "/v1/chat/completions", body);
    const text = await r.text();
    expect(text.includes("real answer") || text.includes("error")).toBe(true);
  });
});
