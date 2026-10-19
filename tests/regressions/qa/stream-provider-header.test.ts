// QA round (real DeepSeek calls): on streaming chat, X-Gateway-Provider carried
// the upstream's `model` string ("deepseek-flash") instead of the target name
// ("ds"), and the HTTP metrics took their `provider` label from that header,
// so streams were counted under the model (an upstream-controlled, unbounded
// label value). /v1/completions set no X-Gateway-Provider at all ("unknown").
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, type RunningGateway } from "@/server/bootstrap";
import { startQaMock, type QaMock } from "./_mock";

let running: RunningGateway;
let mock: QaMock;
let dir: string;
let base: string;
const H = { authorization: "Bearer client-key-123", "content-type": "application/json" };

beforeAll(async () => {
  mock = startQaMock({ model: "upstream-model-x" });
  dir = mkdtempSync(join(tmpdir(), "agw-prov-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(
    cfg,
    `strategy: { mode: single, targets: [tgt-a] }
targets:
  - { name: tgt-a, provider: openai, apiKey: sk-x, baseURL: "${mock.url}" }
auth: { enabled: true, keys: ["client-key-123"] }
`,
  );
  running = await bootstrap(cfg, {
    port: 0,
    host: "127.0.0.1",
    dataDir: join(dir, "data"),
    installSignalHandlers: false,
  });
  base = `http://127.0.0.1:${running.server.port}`;
});
afterAll(async () => {
  await running?.stop("test done");
  mock?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });

describe("X-Gateway-Provider names the target on every surface", () => {
  it("streaming chat: the target, not the upstream model", async () => {
    const res = await post("/v1/chat/completions", {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    await res.text();
    expect(res.headers.get("X-Gateway-Provider")).toBe("tgt-a");
  });

  it("legacy completions, non-stream and stream", async () => {
    const a = await post("/v1/completions", { model: "m", prompt: "x" });
    await a.text();
    expect(a.headers.get("X-Gateway-Provider")).toBe("tgt-a");
    const b = await post("/v1/completions", { model: "m", prompt: "x", stream: true });
    await b.text();
    expect(b.headers.get("X-Gateway-Provider")).toBe("tgt-a");
  });

  it("the HTTP metrics never use the upstream model as provider label", async () => {
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).not.toContain('provider="upstream-model-x"');
    expect(text).toMatch(/ai_gateway_requests_total\{method="POST",status="200",provider="tgt-a"\} [3-9]/);
  });
});
