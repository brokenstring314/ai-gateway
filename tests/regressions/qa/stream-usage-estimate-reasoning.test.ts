// QA round (real DeepSeek reasoning streams): when a stream carries no usage
// chunk, usage is estimated (~4 chars/token) so budgets cannot be bypassed.
// The estimate counted only delta.content and tool-call text, not
// delta.reasoning_content / delta.reasoning, so a reasoning model's thinking
// (often most of the output tokens) was free for the budget plugin and
// missing from token metrics and the request log.
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
const ADMIN = { authorization: "Bearer admin-secret-0123456789" };

beforeAll(async () => {
  mock = startQaMock();
  dir = mkdtempSync(join(tmpdir(), "agw-reason-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(
    cfg,
    `strategy: { mode: single, targets: [a] }
targets:
  - { name: a, provider: openai, apiKey: sk-x, baseURL: "${mock.url}" }
auth: { enabled: true, keys: ["client-key-123"] }
adminSecret: "admin-secret-0123456789"
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

describe("estimated stream usage counts reasoning text", () => {
  it("4000 chars of reasoning_content count as ~1000 completion tokens", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer client-key-123", "content-type": "application/json" },
      body: JSON.stringify({ model: "reasoning-nousage", stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    const text = await res.text();
    expect(text).toContain("reasoning_content");
    expect(text).toContain("data: [DONE]");
    const logs = await fetch(`${base}/admin/logs?limit=1`, { headers: ADMIN });
    const body = (await logs.json()) as { entries: { completionTokens: number }[] };
    expect(body.entries[0]!.completionTokens).toBeGreaterThanOrEqual(1000);
  });
});
