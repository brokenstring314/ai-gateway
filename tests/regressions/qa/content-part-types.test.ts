// QA round (client-body fuzz): message content parts other than `text` and
// `image_url` (`input_audio`, `file`, an assistant `refusal` part …) were
// rejected with 400 validation_failed, although they are valid OpenAI Chat
// Completions input that an OpenAI-compatible target may accept. They are
// forwarded verbatim now (an allow-list: input_audio, file, refusal); text
// parts keep working with the plugins.
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
  dir = mkdtempSync(join(tmpdir(), "agw-parts-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(
    cfg,
    `strategy: { mode: single, targets: [a] }
targets:
  - { name: a, provider: openai, apiKey: sk-x, baseURL: "${mock.url}" }
auth: { enabled: true, keys: ["client-key-123"] }
plugins:
  - name: word-filter
    stage: before_request
    config: { blockedWords: ["forbidden"], mode: redact }
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

describe("non-text / non-image content parts", () => {
  it("input_audio, file and refusal parts reach the upstream verbatim", async () => {
    const audio = { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } };
    const file = { type: "file", file: { file_id: "file-abc", filename: "a.pdf" } };
    const refusal = { type: "refusal", refusal: "I can't help with that." };
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer client-key-123", "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: [{ type: "text", text: "a forbidden word" }, audio, file] },
          { role: "assistant", content: [refusal] },
          { role: "user", content: "ok" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const sent = mock.bodies.at(-1);
    expect(sent.messages[0].content).toEqual([{ type: "text", text: "a *** word" }, audio, file]);
    expect(sent.messages[1].content).toEqual([refusal]);
  });

  it("a part without a type, or an unknown (text-bearing) type, is still a validation error", async () => {
    for (const part of [{ text: "x" }, { type: "input_text", text: "sk-secret" }]) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer client-key-123", "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: [part] }] }),
      });
      expect(res.status).toBe(400);
    }
  });
});
