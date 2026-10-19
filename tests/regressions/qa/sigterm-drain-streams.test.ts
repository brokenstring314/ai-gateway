// QA round (load testing): SIGTERM under streaming load cut every in-flight
// stream. The drain's in-flight counter was decremented as soon as the
// handler returned the SSE Response, i.e. before its body was written, so
// the drain finished at once and server.stop(true) reset the connections
// (200 of 200 in-flight streams ended with ECONNRESET mid-body).
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, type RunningGateway } from "@/server/bootstrap";
import { startQaMock, type QaMock } from "./_mock";

let running: RunningGateway | undefined;
let mock: QaMock | undefined;
let dir: string | undefined;
afterEach(async () => {
  await running?.stop("test done");
  mock?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  running = mock = dir = undefined;
});

async function start(): Promise<string> {
  mock = startQaMock({ chunks: 8, gapMs: 60 });
  dir = mkdtempSync(join(tmpdir(), "agw-drain-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(
    cfg,
    `strategy: { mode: single, targets: [a] }
targets:
  - { name: a, provider: openai, apiKey: sk-x, baseURL: "${mock.url}" }
auth: { enabled: true, keys: ["client-key-123"] }
`,
  );
  running = await bootstrap(cfg, {
    port: 0,
    host: "127.0.0.1",
    dataDir: join(dir, "data"),
    installSignalHandlers: false,
  });
  return `http://127.0.0.1:${running.server.port}`;
}

describe("graceful shutdown drains in-flight streams", () => {
  it("a stream that started before stop() runs to [DONE] within the grace", async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer client-key-123", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value);
    const stopping = running!.stop("SIGTERM (test)");
    running = undefined;
    let error: unknown;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
    } catch (err) {
      error = err;
    }
    await stopping;
    expect(error).toBeUndefined();
    expect(text).toContain("t7");
    expect(text).toContain("data: [DONE]");
  });

  it("the in-flight count returns to 0 when the client cancels or the stream completes", async () => {
    const base = await start();
    const post = () =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer client-key-123", "content-type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
    const inFlight = running!.shutdown.inFlight;
    const a = await post();
    const ra = a.body!.getReader();
    await ra.read();
    expect(inFlight.pending).toBe(1);
    await ra.cancel();
    for (let i = 0; i < 100 && inFlight.pending > 0; i++) await Bun.sleep(10);
    expect(inFlight.pending).toBe(0);
    const b = await post();
    expect(await b.text()).toContain("data: [DONE]");
    for (let i = 0; i < 50 && inFlight.pending > 0; i++) await Bun.sleep(10);
    expect(inFlight.pending).toBe(0);
  });
});
