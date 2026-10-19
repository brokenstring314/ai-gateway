// QA round (real DeepSeek calls + client-body fuzz): explicit `null` optional
// parameters ("temperature": null, "tools": null, "stop": null, a message's
// "name": null …) were rejected with 400 validation_failed, while the OpenAI
// API and DeepSeek both accept them as "not set" (verified against
// api.deepseek.com). Several client libraries send such nulls.
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

beforeAll(async () => {
  mock = startQaMock();
  dir = mkdtempSync(join(tmpdir(), "agw-null-"));
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
  base = `http://127.0.0.1:${running.server.port}`;
});
afterAll(async () => {
  await running?.stop("test done");
  mock?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer client-key-123", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const NULLS = {
  temperature: null,
  top_p: null,
  n: null,
  stop: null,
  max_tokens: null,
  presence_penalty: null,
  frequency_penalty: null,
  logit_bias: null,
  user: null,
  seed: null,
  tools: null,
  tool_choice: null,
  response_format: null,
  logprobs: null,
  top_logprobs: null,
  stream: null,
  stream_options: null,
  parallel_tool_calls: null,
};

describe("explicit null optional parameters mean 'not set'", () => {
  it("chat completions: every optional top-level param null, message name/tool_calls null", async () => {
    const res = await post("/v1/chat/completions", {
      model: "m",
      ...NULLS,
      messages: [
        { role: "user", content: "hi", name: null },
        { role: "assistant", content: "ok", tool_calls: null, name: null },
        { role: "user", content: "again" },
      ],
    });
    expect(res.status).toBe(200);
    const sent = mock.bodies.at(-1);
    expect(sent.temperature).toBeUndefined();
    expect(sent.tools).toBeUndefined();
    expect(sent.messages[1]).toEqual({ role: "assistant", content: "ok" });
  });

  it("legacy completions accept null optional params", async () => {
    const res = await post("/v1/completions", {
      model: "m",
      prompt: "x",
      max_tokens: null,
      temperature: null,
      stop: null,
    });
    expect(res.status).toBe(200);
  });

  it("embeddings accept null optional params (validation passes; upstream error is unrelated)", async () => {
    const res = await post("/v1/embeddings", {
      model: "m",
      input: "x",
      dimensions: null,
      user: null,
      encoding_format: null,
    });
    expect(res.status).not.toBe(400);
  });
});
