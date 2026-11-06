/**
 * FC-1 (final red team 2026-11-06): no database access on the request path.
 *
 *  - validateKey() answers from the in-memory snapshot: no statement runs per
 *    request (valid, unknown, revoked and expired keys alike);
 *  - writes through the store (revoke / rotate / patch / expiry / delete)
 *    take effect on the very next call;
 *  - writes by another process (the CLI) are picked up by the background
 *    sync within one interval;
 *  - expiry is checked against the clock on every call;
 *  - usage_count / last_used_at are counted in memory and written by the
 *    sync / close(); a foreign write lock never blocks validateKey and the
 *    flush retries later instead of waiting;
 *  - request_logs are queued and written in batches: bounded queue with a
 *    drop counter, flushed before reads and on close(), retried when busy.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore, keyStorePath, openKeyStoreDatabase } from "@/persistence/key-store";
import { RequestLogStore, type RequestLogEntry } from "@/persistence/request-log-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aigw-fc1-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function openStore(opts: { syncIntervalMs?: number; busyTimeoutMs?: number } = {}) {
  const db = openKeyStoreDatabase(keyStorePath(dir), { busyTimeoutMs: opts.busyTimeoutMs ?? 1000 });
  return KeyStore.create(db, { syncIntervalMs: opts.syncIntervalMs ?? 0, busyTimeoutMs: opts.busyTimeoutMs ?? 1000 });
}

/**
 * Wrap a Database so every statement execution and ad-hoc call is counted
 * (bun:sqlite statements carry get/all/run as own properties, so the
 * statements handed out by prepare()/query() are wrapped too).
 */
function instrument(real: Database): { db: Database; calls: () => number } {
  let n = 0;
  const STMT_METHODS = new Set(["get", "all", "run", "values", "iterate", "raw"]);
  const wrapStmt = <T extends object>(stmt: T): T =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof prop === "string" && STMT_METHODS.has(prop) && typeof v === "function") {
          return (...args: unknown[]) => {
            n += 1;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  const db = new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (prop === "prepare" || prop === "query") {
        return (...args: unknown[]) => {
          n += 1;
          return wrapStmt((v as (...a: unknown[]) => object).apply(target, args));
        };
      }
      if (prop === "exec" || prop === "run" || prop === "transaction") {
        return (...args: unknown[]) => {
          n += 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { db, calls: () => n };
}

async function until(cond: () => boolean, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(10);
  }
  return Date.now() - start;
}

describe("FC-1 KeyStore: no database access per request", () => {
  it("validateKey runs no SQL for valid, unknown, revoked and expired keys", async () => {
    const counted = instrument(openKeyStoreDatabase(keyStorePath(dir), { busyTimeoutMs: 1000 }));
    const store = await KeyStore.create(counted.db, { syncIntervalMs: 0, busyTimeoutMs: 1000 });
    const ok = store.create("ok", ["inference"]);
    const revoked = store.create("revoked", ["inference"]);
    store.revoke(revoked.id);
    const expired = store.create("expired", ["inference"], new Date(Date.now() - 1000));
    store.warm();
    // Sanity: the instrumentation sees statements when the database is used.
    let before = counted.calls();
    store.get(ok.id);
    expect(counted.calls()).toBeGreaterThan(before);

    before = counted.calls();
    for (let i = 0; i < 200; i++) {
      expect(store.validateKey(ok.key)?.id).toBe(ok.id);
      expect(store.validateKey(revoked.key)).toBeNull();
      expect(store.validateKey(expired.key)).toBeNull();
      expect(store.validateKey(`fgw_${i.toString(16).padStart(40, "0")}`)).toBeNull();
    }
    expect(counted.calls() - before).toBe(0);
    // The counters still reach the database, off the request path.
    store.syncNow();
    expect(counted.calls()).toBeGreaterThan(before);
    store.close();
  });

  it("revoke / rotate / patch / expiry / delete through the store apply on the next call", async () => {
    const store = await openStore();
    const a = store.create("a", ["inference"]);
    const b = store.create("b", ["inference"]);
    const c = store.create("c", ["inference"]);
    const d = store.create("d", ["inference"]);
    store.warm();
    for (const k of [a, b, c, d]) expect(store.validateKey(k.key)).not.toBeNull();

    store.revoke(a.id);
    expect(store.validateKey(a.key)).toBeNull();

    const rotated = store.rotateKey(b.id);
    expect(store.validateKey(b.key)).toBeNull();
    expect(store.validateKey(rotated.key)?.id).toBe(b.id);

    store.patch(c.id, { scopes: ["read_only"], allowedModels: ["m1"], quotaTokens: 5 });
    const pc = store.validateKey(c.key);
    expect(pc?.scopes).toEqual(["read_only"]);
    expect(pc?.allowedModels).toEqual(["m1"]);
    expect(pc?.quotaTokens).toBe(5);

    store.setExpiration(c.id, new Date(Date.now() - 1));
    expect(store.validateKey(c.key)).toBeNull();

    store.delete(d.id);
    expect(store.validateKey(d.key)).toBeNull();
    store.close();
  });

  it("expiry is checked against the clock on every call (cached key)", async () => {
    const counted = instrument(openKeyStoreDatabase(keyStorePath(dir), { busyTimeoutMs: 1000 }));
    const store = await KeyStore.create(counted.db, { syncIntervalMs: 0 });
    const k = store.create("soon", ["inference"], new Date(Date.now() + 150));
    store.warm();
    expect(store.validateKey(k.key)).not.toBeNull();
    await Bun.sleep(200);
    const before = counted.calls();
    expect(store.validateKey(k.key)).toBeNull();
    expect(counted.calls()).toBe(before);
    store.close();
  });

  it("the returned key is a copy: changing it does not change the snapshot", async () => {
    const store = await openStore();
    const k = store.create("k", ["inference"], undefined, { allowedModels: ["m"] });
    const v = store.validateKey(k.key)!;
    v.scopes.push("admin");
    v.allowedModels!.push("other");
    v.active = false;
    const again = store.validateKey(k.key)!;
    expect(again.scopes).toEqual(["inference"]);
    expect(again.allowedModels).toEqual(["m"]);
    store.close();
  });

  it("CLI writes (another connection) are picked up within the sync interval: revoke, create", async () => {
    const server = await openStore({ syncIntervalMs: 100 });
    const k = server.create("client", ["inference"]);
    server.warm();
    expect(server.validateKey(k.key)).not.toBeNull();

    const cli = await KeyStore.create(openKeyStoreDatabase(keyStorePath(dir), { create: false }));
    cli.revoke(k.id);
    const created = cli.create("from-cli", ["inference"]);
    cli.close();

    const revokedAfter = await until(() => server.validateKey(k.key) === null, 1000);
    expect(revokedAfter).toBeLessThan(1000);
    await until(() => server.validateKey(created.key) !== null, 1000);
    server.close();
  });

  it("syncNow() picks up a CLI revoke without the timer", async () => {
    const server = await openStore();
    const k = server.create("client", ["inference"]);
    server.warm();
    const raw = new Database(keyStorePath(dir));
    raw.exec("PRAGMA busy_timeout = 1000");
    raw.prepare("UPDATE api_keys SET revoked_at = ?, active = 0 WHERE id = ?").run(new Date().toISOString(), k.id);
    raw.close();
    expect(server.validateKey(k.key)).not.toBeNull(); // not yet synced
    server.syncNow();
    expect(server.validateKey(k.key)).toBeNull();
    server.close();
  });

  it("usage_count / last_used_at: counted in memory, visible via get(), written by syncNow() and close()", async () => {
    let store = await openStore();
    const k = store.create("u", ["inference"]);
    for (let i = 0; i < 5; i++) store.validateKey(k.key);
    const live = store.get(k.id)!;
    expect(live.usageCount).toBe(5);
    expect(live.lastUsedAt).not.toBeNull();

    const raw = new Database(keyStorePath(dir), { readonly: true });
    const persisted = () =>
      (raw.query("SELECT usage_count AS n, last_used_at AS at FROM api_keys WHERE id = ?").get(k.id) as {
        n: number;
        at: string | null;
      })!;
    expect(persisted().n).toBe(0);
    store.syncNow();
    expect(persisted().n).toBe(5);
    expect(persisted().at).not.toBeNull();
    expect(store.get(k.id)!.usageCount).toBe(5);

    store.validateKey(k.key);
    store.validateKey(k.key);
    store.close(); // shutdown flush
    expect(persisted().n).toBe(7);
    raw.close();

    store = await openStore();
    expect(store.get(k.id)!.usageCount).toBe(7);
    store.close();
  });

  it("a foreign write lock does not block validateKey or the flush; the counters are written once it is released", async () => {
    // The server's real busy timeout for admin writes: 1 s. The flush must not wait that long.
    const store = await openStore({ busyTimeoutMs: 1000 });
    const k = store.create("locked", ["inference"]);
    store.warm();

    const holder = new Database(keyStorePath(dir));
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("UPDATE api_keys SET name = name WHERE id = ?").run(k.id);
    try {
      let t = performance.now();
      for (let i = 0; i < 50; i++) expect(store.validateKey(k.key)).not.toBeNull();
      expect(performance.now() - t).toBeLessThan(50);

      t = performance.now();
      store.syncNow(); // flush hits SQLITE_BUSY: must give up fast and keep the counters
      expect(performance.now() - t).toBeLessThan(200);
      expect(store.get(k.id)!.usageCount).toBe(50);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    store.syncNow();
    const raw = new Database(keyStorePath(dir), { readonly: true });
    expect((raw.query("SELECT usage_count AS n FROM api_keys WHERE id = ?").get(k.id) as { n: number }).n).toBe(50);
    raw.close();
    store.close();
  });

  it("server connection: WAL with synchronous=NORMAL and the given busy timeout", async () => {
    const db = openKeyStoreDatabase(keyStorePath(dir), { busyTimeoutMs: 1000 });
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    // 1 = NORMAL
    expect((db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
    expect(Object.values(db.query("PRAGMA busy_timeout").get() as Record<string, number>)[0]).toBe(1000);
    db.close();
  });
});

function entry(traceId: string): RequestLogEntry {
  return {
    traceId,
    stage: "chat",
    model: "m",
    provider: "p",
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
    errorMessage: "",
    createdAt: new Date(),
  };
}

describe("FC-1 RequestLogStore: batched inserts", () => {
  const count = (db: Database) => (db.query("SELECT count(*) AS n FROM request_logs").get() as { n: number }).n;

  it("write() runs no SQL; flush() writes the batch; reads flush first", async () => {
    const db = new Database(join(dir, "logs.sqlite"));
    const counted = instrument(db);
    const store = await RequestLogStore.create(counted.db, { flushIntervalMs: 0 });
    const before = counted.calls();
    for (let i = 0; i < 100; i++) store.write(entry(`t${i}`));
    expect(counted.calls()).toBe(before);
    expect(store.pending).toBe(100);
    expect(count(db)).toBe(0);
    expect(store.list({ limit: 200 }).total).toBe(100); // list flushes first
    expect(store.pending).toBe(0);
    store.close();
  });

  it("the timer writes the queue", async () => {
    const db = new Database(join(dir, "logs.sqlite"));
    const store = await RequestLogStore.create(db, { flushIntervalMs: 30 });
    store.write(entry("a"));
    await until(() => store.pending === 0, 1000);
    expect(count(db)).toBe(1);
    store.close();
  });

  it("bounded queue: rows over the bound are dropped and counted", async () => {
    const db = new Database(join(dir, "logs.sqlite"));
    const drops: number[] = [];
    const store = await RequestLogStore.create(db, { flushIntervalMs: 0, maxQueue: 10, onDrop: (n) => drops.push(n) });
    for (let i = 0; i < 15; i++) store.write(entry(`t${i}`));
    expect(store.pending).toBe(10);
    expect(store.dropped).toBe(5);
    expect(drops.reduce((a, b) => a + b, 0)).toBe(5);
    store.close();
    // After close: dropped, never thrown.
    store.write(entry("late"));
    expect(store.dropped).toBe(6);
  });

  it("close() writes every queued row (SIGTERM path)", async () => {
    const path = join(dir, "logs.sqlite");
    const store = await RequestLogStore.create(new Database(path), { flushIntervalMs: 60_000 });
    for (let i = 0; i < 42; i++) store.write(entry(`t${i}`));
    store.close();
    const db = new Database(path, { readonly: true });
    expect(count(db)).toBe(42);
    db.close();
  });

  it("a locked database keeps the rows queued (fast give-up) and writes them later", async () => {
    const path = join(dir, "logs.sqlite");
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 1000");
    const store = await RequestLogStore.create(db, { flushIntervalMs: 0 });
    store.write(entry("a"));
    store.write(entry("b"));
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("DELETE FROM request_logs WHERE 0");
    try {
      const t = performance.now();
      store.flush({ background: true });
      expect(performance.now() - t).toBeLessThan(200);
      expect(store.pending).toBe(2);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    store.flush({ background: true });
    expect(store.pending).toBe(0);
    expect(count(db)).toBe(2);
    store.close();
  });
});
