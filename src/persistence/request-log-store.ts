import { Database, type SQLQueryBindings } from "bun:sqlite";
import { runMigrations, type MigrationStep, DeferredStepError } from "@/persistence/migrations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestLogEntry {
  traceId: string;
  stage: string;
  /** Published model name (B3; rows written before 0.3.0 may hold the upstream's name for successes). */
  model: string;
  /** Model name the upstream answered with / was sent (B3); absent when no upstream was involved or on older rows. */
  upstreamModel?: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errorMessage: string;
  createdAt: Date;
  /** 0.3.0 P5 (optional for older callers): client key id, token details, latency, HTTP status. */
  keyId?: string;
  cacheHitTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
  status?: number;
}

export interface RequestLogQuery {
  limit?: number;
  offset?: number;
  stage?: string;
  model?: string;
  upstreamModel?: string;
  provider?: string;
  since?: Date;
  /** "error": entries with an error message (or stage on_error); "ok": the rest. */
  status?: "error" | "ok";
}

export interface RequestLogListResult {
  data: RequestLogEntry[];
  total: number;
}

export interface RequestLogStatsResult {
  totalEntries: number;
  errorEntries: number;
  totalTokens: number;
  byStage: Record<string, number>;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
}

export interface RequestLogMaintenanceQuery {
  before: Date;
  stage?: string;
  model?: string;
  provider?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const REQUEST_LOG_LEDGER = "request_log_schema_migrations";
const REQUEST_LOG_TABLE = "request_logs";
const CREATED_AT_INDEX = "idx_request_logs_created_at";

// ---------------------------------------------------------------------------
// Migration steps
// ---------------------------------------------------------------------------

const BASELINE_DDL = `
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY,
  trace_id TEXT,
  stage TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL
);`;

function buildMigrationSteps(): MigrationStep[] {
  return [
    {
      version: 1,
      name: "request_logs_baseline",
      sql: BASELINE_DDL,
    },
    {
      version: 2,
      name: "request_logs_created_at_index",
      noTx: (db: Database) => {
        try {
          db.exec(`CREATE INDEX IF NOT EXISTS ${CREATED_AT_INDEX} ON request_logs (created_at)`);
        } catch (err) {
          throw new DeferredStepError(`build request log index: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      // 0.3.0 P5: per-request key id, cache-hit / reasoning tokens, latency and status.
      version: 3,
      name: "request_logs_usage_details",
      fn: (db: Database) => {
        const cols = new Set(
          (db.query("PRAGMA table_info(request_logs)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        const add = (name: string, ddl: string) => {
          if (!cols.has(name)) db.exec(`ALTER TABLE request_logs ADD COLUMN ${ddl}`);
        };
        add("key_id", "key_id TEXT");
        add("cache_hit_tokens", "cache_hit_tokens INTEGER NOT NULL DEFAULT 0");
        add("reasoning_tokens", "reasoning_tokens INTEGER NOT NULL DEFAULT 0");
        add("duration_ms", "duration_ms INTEGER");
        add("status", "status INTEGER");
      },
    },
    {
      // B3 (UI test 2026-11-05): `model` is the published name; the upstream's own name is kept apart.
      version: 4,
      name: "request_logs_upstream_model",
      fn: (db: Database) => {
        const cols = new Set(
          (db.query("PRAGMA table_info(request_logs)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        if (!cols.has("upstream_model")) db.exec("ALTER TABLE request_logs ADD COLUMN upstream_model TEXT");
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Stats query template (UNION ALL across 3 dimensions)
// ---------------------------------------------------------------------------

const STATS_QUERY_TEMPLATE = `
SELECT 'stage' AS dim,
       COALESCE(NULLIF(stage, ''), 'unknown') AS grp,
       COUNT(*) AS cnt,
       SUM(CASE WHEN (error_message IS NOT NULL AND error_message <> '') OR stage = 'on_error' THEN 1 ELSE 0 END) AS errs,
       COALESCE(SUM(total_tokens), 0) AS toks
FROM request_logs{whereClause}
GROUP BY COALESCE(NULLIF(stage, ''), 'unknown')
UNION ALL
SELECT 'provider', COALESCE(NULLIF(provider, ''), 'unknown'), COUNT(*),
       SUM(CASE WHEN (error_message IS NOT NULL AND error_message <> '') OR stage = 'on_error' THEN 1 ELSE 0 END),
       COALESCE(SUM(total_tokens), 0)
FROM request_logs{whereClause}
GROUP BY COALESCE(NULLIF(provider, ''), 'unknown')
UNION ALL
SELECT 'model', COALESCE(NULLIF(model, ''), 'unknown'), COUNT(*),
       SUM(CASE WHEN (error_message IS NOT NULL AND error_message <> '') OR stage = 'on_error' THEN 1 ELSE 0 END),
       COALESCE(SUM(total_tokens), 0)
FROM request_logs{whereClause}
GROUP BY COALESCE(NULLIF(model, ''), 'unknown')`;

// ---------------------------------------------------------------------------
// WHERE clause builder
// ---------------------------------------------------------------------------

/** Same definition of "error" as the stats query. */
const ERROR_PREDICATE = "(error_message IS NOT NULL AND error_message <> '') OR stage = 'on_error'";

interface WhereClauseResult {
  whereSQL: string;
  args: SQLQueryBindings[];
}

function buildWhereClause(query: {
  stage?: string;
  model?: string;
  upstreamModel?: string;
  provider?: string;
  since?: Date;
  status?: "error" | "ok";
}): WhereClauseResult {
  const clauses: string[] = [];
  const args: SQLQueryBindings[] = [];

  if (query.stage && query.stage !== "") {
    clauses.push("stage = ?");
    args.push(query.stage);
  }
  if (query.model && query.model !== "") {
    clauses.push("model = ?");
    args.push(query.model);
  }
  if (query.upstreamModel && query.upstreamModel !== "") {
    clauses.push("upstream_model = ?");
    args.push(query.upstreamModel);
  }
  if (query.provider && query.provider !== "") {
    clauses.push("provider = ?");
    args.push(query.provider);
  }
  if (query.since) {
    clauses.push("created_at >= ?");
    args.push(query.since.toISOString());
  }
  if (query.status === "error") {
    clauses.push(`(${ERROR_PREDICATE})`);
  } else if (query.status === "ok") {
    clauses.push(`NOT (${ERROR_PREDICATE})`);
  }

  const whereSQL = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { whereSQL, args };
}

// ---------------------------------------------------------------------------
// RequestLogStore
// ---------------------------------------------------------------------------

function toInsertArgs(entry: RequestLogEntry): InsertArgs {
  const createdAt = entry.createdAt.getTime() === 0 ? new Date() : entry.createdAt;
  return [
    entry.traceId,
    entry.stage,
    entry.model,
    entry.provider,
    entry.promptTokens,
    entry.completionTokens,
    entry.totalTokens,
    entry.errorMessage,
    createdAt.toISOString(),
    entry.keyId !== undefined && entry.keyId !== "" ? entry.keyId : null,
    Math.round(entry.cacheHitTokens ?? 0),
    Math.round(entry.reasoningTokens ?? 0),
    entry.durationMs !== undefined ? Math.round(entry.durationMs) : null,
    entry.status ?? null,
    entry.upstreamModel !== undefined && entry.upstreamModel !== "" ? entry.upstreamModel : null,
  ];
}

/**
 * Open the request-log database for the server: WAL (readers never block the
 * batched inserts), synchronous=NORMAL (a
 * crash can lose the last few log rows, never corrupt the file) and a busy
 * timeout, so another writer (`DELETE /admin/logs` elsewhere, a backup) makes
 * an insert wait instead of failing with "database is locked".
 */
export function openRequestLogDatabase(path: string): Database {
  const db = new Database(path, { create: true, readwrite: true });
  // Kept short: bun:sqlite waits synchronously, so a long wait would stall the event loop.
  db.exec("PRAGMA busy_timeout = 1000");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Another connection holds the database in rollback mode; keep its mode.
  }
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/** Default bound of the in-memory write queue (rows); beyond it new rows are dropped and counted. */
export const DEFAULT_REQUEST_LOG_MAX_QUEUE = 10_000;
/** Flush early once this many rows are queued. */
const FLUSH_BATCH = 500;
/** Busy timeout of a timer flush: never stall the event loop; a busy database is retried next tick. */
const FLUSH_BUSY_TIMEOUT_MS = 25;

export interface RequestLogStoreOptions {
  /**
   * Batch flush interval in ms (default 1000). 0: no timer; rows are still
   * written by flush(), before every read (list / stats / delete) and on close().
   */
  flushIntervalMs?: number;
  /** Bound of the write queue (default 10 000 rows). */
  maxQueue?: number;
  /** Called with the number of rows dropped (queue full, or written after close). */
  onDrop?: (count: number) => void;
}

const INSERT_SQL = `INSERT INTO request_logs(trace_id, stage, model, provider, prompt_tokens, completion_tokens, total_tokens, error_message, created_at, key_id, cache_hit_tokens, reasoning_tokens, duration_ms, status, upstream_model)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

type InsertArgs = [
  string,
  string,
  string,
  string,
  number,
  number,
  number,
  string,
  string,
  string | null,
  number,
  number,
  number | null,
  number | null,
  string | null,
];

/**
 * Request log persistence. Writes are batched (FC-1): write() only queues the
 * row in memory; a timer (default every second), any read, and close() write
 * the queue in one transaction. The queue is bounded; rows beyond the bound
 * are dropped and counted (ai_gateway_request_log_dropped_total). A busy
 * database keeps the rows queued for the next flush.
 */
export class RequestLogStore {
  private db: Database;
  private readonly migrationPromise: Promise<void>;
  private queue: InsertArgs[] = [];
  private readonly maxQueue: number;
  private readonly onDrop: ((count: number) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private droppedTotal = 0;

  constructor(db: Database, opts: RequestLogStoreOptions = {}) {
    this.db = db;
    this.maxQueue = Math.max(1, Math.floor(opts.maxQueue ?? DEFAULT_REQUEST_LOG_MAX_QUEUE));
    this.onDrop = opts.onDrop;
    this.migrationPromise = runMigrations(db, buildMigrationSteps(), {
      ledger: REQUEST_LOG_LEDGER,
      primaryTable: REQUEST_LOG_TABLE,
    });
    const interval = opts.flushIntervalMs ?? 1000;
    if (interval > 0) {
      this.timer = setInterval(() => this.flush({ background: true }), interval);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Async factory: awaits the same migration run as the constructor. */
  static async create(db: Database, opts?: RequestLogStoreOptions): Promise<RequestLogStore> {
    const store = new RequestLogStore(db, opts);
    await store.migrationPromise;
    return store;
  }

  // -- Write -----------------------------------------------------------------

  /** Queue one row (memory only; see the class comment). Never touches the database. */
  write(entry: RequestLogEntry): void {
    if (this.closed || this.queue.length >= this.maxQueue) {
      this.drop(1);
      return;
    }
    this.queue.push(toInsertArgs(entry));
    if (this.queue.length >= FLUSH_BATCH) queueMicrotask(() => this.flush({ background: true }));
  }

  /** Rows waiting to be written. */
  get pending(): number {
    return this.queue.length;
  }

  /** Rows dropped so far (queue full / after close). */
  get dropped(): number {
    return this.droppedTotal;
  }

  /**
   * Write every queued row in one transaction. Never throws: on failure (a
   * locked database) the rows go back to the front of the queue (still
   * bounded) for the next flush. `background`: short busy timeout.
   */
  flush(opts: { background?: boolean } = {}): void {
    if (this.queue.length === 0 || this.closed) return;
    const batch = this.queue;
    this.queue = [];
    try {
      const write = () => {
        const stmt = this.db.query(INSERT_SQL);
        this.db.transaction(() => {
          for (const args of batch) stmt.run(...args);
        })();
      };
      if (opts.background) this.withBusyTimeout(FLUSH_BUSY_TIMEOUT_MS, write);
      else write();
    } catch (err) {
      console.error(
        `[request-log] could not write ${batch.length} request log row(s), will retry: ${err instanceof Error ? err.message : String(err)}`,
      );
      const merged = batch.concat(this.queue);
      const over = merged.length - this.maxQueue;
      if (over > 0) {
        // Keep the newest rows.
        merged.splice(0, over);
        this.drop(over);
      }
      this.queue = merged;
    }
  }

  private drop(count: number): void {
    this.droppedTotal += count;
    try {
      this.onDrop?.(count);
    } catch {
      // A metrics failure must not break logging.
    }
  }

  private withBusyTimeout<T>(ms: number, fn: () => T): T {
    const row = this.db.query("PRAGMA busy_timeout").get() as Record<string, number> | null;
    const previous = row ? (Object.values(row)[0] ?? 1000) : 1000;
    this.db.exec(`PRAGMA busy_timeout = ${ms}`);
    try {
      return fn();
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${previous}`);
    }
  }

  // -- List ------------------------------------------------------------------

  list(query: RequestLogQuery): RequestLogListResult {
    this.flush({ background: true });
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    const { whereSQL, args } = buildWhereClause(query);

    // Count total matching rows
    const countRow = this.db.prepare(`SELECT COUNT(*) AS total FROM request_logs${whereSQL}`).get(...args) as {
      total: number;
    } | null;
    const total = countRow?.total ?? 0;

    // Fetch paginated rows
    const rows = this.db
      .prepare(
        `SELECT trace_id, stage, model, provider, prompt_tokens, completion_tokens, total_tokens, error_message, created_at,
                key_id, cache_hit_tokens, reasoning_tokens, duration_ms, status, upstream_model
         FROM request_logs${whereSQL}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Array<{
      trace_id: string | null;
      stage: string;
      model: string | null;
      provider: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      error_message: string | null;
      created_at: string;
      key_id: string | null;
      cache_hit_tokens: number;
      reasoning_tokens: number;
      duration_ms: number | null;
      status: number | null;
      upstream_model: string | null;
    }>;

    const data: RequestLogEntry[] = rows.map((row) => ({
      traceId: row.trace_id ?? "",
      stage: row.stage,
      model: row.model ?? "",
      ...(row.upstream_model !== null ? { upstreamModel: row.upstream_model } : {}),
      provider: row.provider ?? "",
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      errorMessage: row.error_message ?? "",
      createdAt: new Date(row.created_at),
      ...(row.key_id !== null ? { keyId: row.key_id } : {}),
      cacheHitTokens: row.cache_hit_tokens,
      reasoningTokens: row.reasoning_tokens,
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
      ...(row.status !== null ? { status: row.status } : {}),
    }));

    return { data, total };
  }

  // -- Stats -----------------------------------------------------------------

  stats(query: RequestLogQuery): RequestLogStatsResult {
    this.flush({ background: true });
    const { whereSQL, args } = buildWhereClause(query);

    const statsQuery = STATS_QUERY_TEMPLATE.replaceAll("{whereClause}", whereSQL);

    // WHERE clause args repeat 3 times (once per UNION ALL branch)
    const allArgs: SQLQueryBindings[] = [...args, ...args, ...args];

    const rows = this.db.prepare(statsQuery).all(...allArgs) as Array<{
      dim: string;
      grp: string;
      cnt: number;
      errs: number;
      toks: number;
    }>;

    const result: RequestLogStatsResult = {
      totalEntries: 0,
      errorEntries: 0,
      totalTokens: 0,
      byStage: {},
      byProvider: {},
      byModel: {},
    };

    for (const row of rows) {
      switch (row.dim) {
        case "stage":
          result.byStage[row.grp] = row.cnt;
          result.totalEntries += row.cnt;
          result.errorEntries += row.errs;
          result.totalTokens += row.toks;
          break;
        case "provider":
          result.byProvider[row.grp] = row.cnt;
          break;
        case "model":
          result.byModel[row.grp] = row.cnt;
          break;
      }
    }

    return result;
  }

  // -- Delete ----------------------------------------------------------------

  delete(query: RequestLogMaintenanceQuery): number {
    // Queued rows first, so a delete also covers rows logged just before it.
    this.flush();
    const clauses: string[] = ["created_at < ?"];
    const args: SQLQueryBindings[] = [query.before.toISOString()];

    if (query.stage && query.stage !== "") {
      clauses.push("stage = ?");
      args.push(query.stage);
    }
    if (query.model && query.model !== "") {
      clauses.push("model = ?");
      args.push(query.model);
    }
    if (query.provider && query.provider !== "") {
      clauses.push("provider = ?");
      args.push(query.provider);
    }

    const deleteQuery = `DELETE FROM request_logs WHERE ${clauses.join(" AND ")}`;
    const result = this.db.prepare(deleteQuery).run(...args);
    return result.changes;
  }

  // -- Ping / Close ----------------------------------------------------------

  ping(): void {
    this.db.query("SELECT 1").get();
  }

  /** Write the queue (SIGTERM: the last request rows), stop the timer, close the database. */
  close(): void {
    if (this.closed) return;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
    if (this.queue.length > 0) this.drop(this.queue.length);
    this.queue = [];
    this.closed = true;
    this.db.close();
  }
}
