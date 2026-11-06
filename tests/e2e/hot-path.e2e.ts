/**
 * FC-1 (final red team 2026-11-06) on a real server process: the request
 * path does not touch the key store, so
 *
 *  - another process holding the write lock on api-keys.sqlite (the CLI, a
 *    sqlite3 shell, a backup tool) freezes neither /livez nor authenticated
 *    requests (each < 200 ms while the lock is held);
 *  - a key revoked by the CLI is refused within the sync interval (~1 s);
 *  - SIGTERM writes the queued request_logs rows and the in-memory
 *    usage_count of every key before the process exits.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_SECRET, baseConfig, type GatewayProcess, postJson, REPO_ROOT, startGateway } from "./harness/gateway";
import { type MockUpstream, startMockUpstream } from "./harness/mock-upstream";

let up: MockUpstream;
beforeAll(() => {
  up = startMockUpstream("a");
});
afterAll(() => up?.stop());

async function createKey(gw: GatewayProcess, name: string): Promise<{ id: string; key: string }> {
  const r = await gw.fetch("/admin/keys", {
    method: "POST",
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
    auth: null,
    body: JSON.stringify({ name }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; key: string };
}

async function timed(p: () => Promise<Response>): Promise<{ status: number; ms: number }> {
  const t = performance.now();
  const r = await p();
  await r.arrayBuffer();
  return { status: r.status, ms: performance.now() - t };
}

const chat = (gw: GatewayProcess, key: string) =>
  postJson(gw, "/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, { auth: key });

describe("FC-1: no key-store I/O on the request path (real server)", () => {
  it("a foreign write lock on api-keys.sqlite freezes neither /livez nor authenticated requests; CLI revoke applies within the window", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aigw-fc1-"));
    const gw = await startGateway({ config: baseConfig([{ name: "a", mock: up }]), dataDir });
    try {
      const k = await createKey(gw, "locked");
      expect((await chat(gw, k.key)).status).toBe(200);

      const holder = new Database(join(dataDir, "api-keys.sqlite"));
      holder.exec("PRAGMA busy_timeout = 2000");
      holder.exec("BEGIN IMMEDIATE");
      holder.prepare("UPDATE api_keys SET name = name WHERE id = ?").run(k.id);
      const samples: Array<{ status: number; ms: number }> = [];
      try {
        // Span more than one key-store sync tick (1 s) and usage flush while the lock is held.
        const end = Date.now() + 1800;
        while (Date.now() < end) {
          const [authd, live] = await Promise.all([timed(() => chat(gw, k.key)), timed(() => gw.fetch("/livez"))]);
          samples.push(authd, live);
          await Bun.sleep(100);
        }
      } finally {
        holder.exec("ROLLBACK");
        holder.close();
      }
      expect(samples.length).toBeGreaterThan(6);
      for (const s of samples) {
        expect(s.status).toBe(200);
        expect(s.ms).toBeLessThan(200);
      }

      // CLI revoke from another process: refused within the sync interval (+ margin).
      const proc = Bun.spawn([process.execPath, "src/index.ts", "keys", "revoke", k.id, "-c", gw.configPath], {
        cwd: REPO_ROOT,
        env: { ...process.env, GATEWAY_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      const revokedAt = Date.now();
      let status = 0;
      while (Date.now() - revokedAt < 3000) {
        const r = await chat(gw, k.key);
        status = r.status;
        await r.arrayBuffer();
        if (status === 401) break;
        await Bun.sleep(25);
      }
      expect(status).toBe(401);
      expect(Date.now() - revokedAt).toBeLessThan(2500);
    } finally {
      await gw.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("SIGTERM writes the queued request_logs rows and the keys' usage_count", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aigw-fc1-term-"));
    const gw = await startGateway({
      config: baseConfig([{ name: "a", mock: up }]),
      dataDir,
      // Timers far away: only the shutdown flush can write them.
      env: {
        REQUEST_LOG_FLUSH_INTERVAL_MS: "600000",
        KEY_STORE_SYNC_INTERVAL_MS: "10000",
        USAGE_FLUSH_INTERVAL_MS: "600000",
      },
    });
    let id = "";
    try {
      const k = await createKey(gw, "term");
      id = k.id;
      for (let i = 0; i < 3; i++) expect((await chat(gw, k.key)).status).toBe(200);
      expect(await gw.stop("SIGTERM")).toBe(0);

      const logs = new Database(join(dataDir, "request-logs.sqlite"), { readonly: true });
      const rows = logs.query("SELECT count(*) AS n FROM request_logs WHERE key_id = ?").get(id) as { n: number };
      logs.close();
      expect(rows.n).toBe(3);
      const keys = new Database(join(dataDir, "api-keys.sqlite"), { readonly: true });
      const usage = keys.query("SELECT usage_count AS n, last_used_at AS at FROM api_keys WHERE id = ?").get(id) as {
        n: number;
        at: string | null;
      };
      keys.close();
      expect(usage.n).toBe(3);
      expect(usage.at).not.toBeNull();
    } finally {
      await gw.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
