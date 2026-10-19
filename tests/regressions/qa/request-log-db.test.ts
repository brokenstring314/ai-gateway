// QA round (load testing): the request-log SQLite database was opened with
// the default rollback journal, synchronous=FULL and no busy timeout. Every
// request commits one row synchronously on the event loop, so on a slow
// volume the whole gateway was capped by fsync latency (~100 req/s on a
// network filesystem, p50 1.8 s at 200 concurrent vs ~4,000 req/s on tmpfs),
// and any other writer (`DELETE /admin/logs` from another replica/CLI, a
// backup) made log writes fail at once with "database is locked".
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
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
  dir = mkdtempSync(join(tmpdir(), "agw-logdb-"));
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

const chat = (content: string) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer client-key-123", "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content }] }),
  });

describe("request-log database", () => {
  it("is in WAL mode", () => {
    const db = new Database(join(dir, "data", "request-logs.sqlite"), { readonly: true });
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    db.close();
    expect(row.journal_mode).toBe("wal");
  });

  it("a write lock held briefly by another connection does not lose the log entry", async () => {
    // The other writer is another process (CLI / another replica): a lock
    // held in this process would block the busy wait it is testing.
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(${JSON.stringify(join(dir, "data", "request-logs.sqlite"))});
         db.exec("PRAGMA busy_timeout = 5000"); db.exec("BEGIN IMMEDIATE");
         console.log("locked");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
      ],
      { stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    await reader.read(); // "locked"
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    };
    try {
      expect((await chat("locked-write-probe")).status).toBe(200);
    } finally {
      console.error = orig;
      await holder.exited;
    }
    expect(errors.filter((e) => e.includes("request-log"))).toEqual([]);
    const res = await fetch(`${base}/admin/logs?limit=5`, {
      headers: { authorization: "Bearer admin-secret-0123456789" },
    });
    const body = (await res.json()) as { entries: { model: string }[]; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  // Also found with real DeepSeek calls: an upstream error was logged with
  // provider "unknown" (the error carried the target only as ProviderError
  // .provider), so /admin/logs could not tell which target failed.
  it("an upstream error is logged under the target that produced it", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer client-key-123", "content-type": "application/json" },
      body: JSON.stringify({ model: "bad-400", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Gateway-Target")).toBe("a");
    const logs = await fetch(`${base}/admin/logs?limit=1`, {
      headers: { authorization: "Bearer admin-secret-0123456789" },
    });
    const body = (await logs.json()) as { entries: { model: string; provider: string; errorMessage: string }[] };
    expect(body.entries[0]!.model).toBe("bad-400");
    expect(body.entries[0]!.provider).toBe("a");
  });
});
