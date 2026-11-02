/**
 * Contract (0.3.0 P5): per-key token quota and usage statistics on a real
 * server process.
 *
 *  - a key with a tiny quota: the admitted stream finishes completely (past
 *    the quota), the next request is refused with 403 quota_exhausted;
 *  - GET /admin/usage reports the key's tokens;
 *  - the used tokens survive a restart (persisted asynchronously, flushed
 *    on shutdown, restored at startup) — the key stays exhausted;
 *  - reset-usage re-opens it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_SECRET, baseConfig, type GatewayProcess, postJson, startGateway } from "./harness/gateway";
import { type MockUpstream, startMockUpstream, USAGE } from "./harness/mock-upstream";

let up: MockUpstream;
beforeAll(() => {
  up = startMockUpstream("a");
});
afterAll(() => up?.stop());

function admin(gw: GatewayProcess, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-admin-secret": ADMIN_SECRET };
  if (body !== undefined) headers["content-type"] = "application/json";
  return gw.fetch(`/admin${path}`, {
    method,
    headers,
    auth: null,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const chat = (gw: GatewayProcess, key: string, stream = false) =>
  postJson(
    gw,
    "/v1/chat/completions",
    {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      // The client asks for the usage chunk (a stream that does not ask is metered but never sees it, C4).
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    },
    { auth: key },
  );

describe("per-key token quota on a real server", () => {
  it("stream finishes past the quota, next request 403, usage reported, restored after restart, reset re-opens", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aigw-quota-"));
    const config = () => baseConfig([{ name: "a", mock: up }]);
    let gw = await startGateway({ config: config(), dataDir });
    try {
      const created = await admin(gw, "POST", "/keys", { name: "friend", quotaTokens: 10 });
      expect(created.status).toBe(201);
      const k = (await created.json()) as { id: string; key: string };

      up.enqueue("stream_usage");
      const s = await chat(gw, k.key, true);
      expect(s.status).toBe(200);
      const text = await s.text();
      expect(text).toContain(`"total_tokens":${USAGE.total_tokens}`);
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

      const refused = await chat(gw, k.key);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as any).error.code).toBe("quota_exhausted");

      const usage = (await (await admin(gw, "GET", "/usage?groupBy=key")).json()) as any;
      const row = usage.data.find((d: any) => d.key === k.id);
      expect(row).toMatchObject({ name: "friend", requests: 2, errors: 1, totalTokens: USAGE.total_tokens });
      const view = (await (await admin(gw, "GET", `/keys/${k.id}`)).json()) as any;
      expect(view).toMatchObject({ usedTokens: USAGE.total_tokens, quotaExhausted: true });

      // Restart on the same data directory: the counter was flushed on shutdown and is restored.
      await gw.stop();
      gw = await startGateway({ config: config(), dataDir });
      expect((await chat(gw, k.key)).status).toBe(403);
      const after = (await (await admin(gw, "GET", "/usage?groupBy=key")).json()) as any;
      expect(after.data.find((d: any) => d.key === k.id).requests).toBe(3);

      const reset = await admin(gw, "POST", `/keys/${k.id}/reset-usage`);
      expect(reset.status).toBe(200);
      expect((await chat(gw, k.key)).status).toBe(200);
    } finally {
      await gw.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("a stream that does not ask for usage is metered with the upstream's real usage and sees no usage chunk (C4)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aigw-quota-"));
    const gw = await startGateway({ config: baseConfig([{ name: "a", mock: up }]), dataDir });
    try {
      const created = await admin(gw, "POST", "/keys", { name: "sdk-default", quotaTokens: 1000 });
      const k = (await created.json()) as { id: string; key: string };
      up.reset();
      const s = await postJson(
        gw,
        "/v1/chat/completions",
        { model: "gpt-4o", messages: [{ role: "user", content: "你好" }], stream: true },
        { auth: k.key },
      );
      expect(s.status).toBe(200);
      const text = await s.text();
      expect(text).not.toContain("total_tokens");
      expect(text).not.toContain('"choices":[]');
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      // The gateway asked the upstream for usage although the client did not.
      expect(up.requests.at(-1)?.body?.stream_options).toEqual({ include_usage: true });
      await Bun.sleep(100);
      const view = (await (await admin(gw, "GET", `/keys/${k.id}`)).json()) as any;
      expect(view.usedTokens).toBe(USAGE.total_tokens);
    } finally {
      await gw.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
