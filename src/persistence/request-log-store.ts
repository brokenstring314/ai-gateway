import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  runMigrations,
  type MigrationStep,
  DeferredStepError,
} from "@/persistence/migrations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestLogEntry {
  traceId: string;
  stage: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errorMessage: string;
  createdAt: Date;
}

export interface RequestLogQuery {
  limit?: number;
  offset?: number;
  stage?: string;
  model?: string;
  provider?: string;
  since?: Date;
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
          db.exec(
            `CREATE INDEX IF NOT EXISTS ${CREATED_AT_INDEX} ON request_logs (created_at)`,
          );
        } catch (err) {
          throw new DeferredStepError(
            `build request log index: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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

interface WhereClauseResult {
  whereSQL: string;
  args: SQLQueryBindings[];
}

function buildWhereClause(query: {
  stage?: string;
  model?: string;
  provider?: string;
  since?: Date;
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
  if (query.provider && query.provider !== "") {
    clauses.push("provider = ?");
    args.push(query.provider);
  }
  if (query.since) {
    clauses.push("created_at >= ?");
    args.push(query.since.toISOString());
  }

  const whereSQL = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { whereSQL, args };
}

// ---------------------------------------------------------------------------
// RequestLogStore
// ---------------------------------------------------------------------------

export class RequestLogStore {
  private db: Database;
  private readonly migrationPromise: Promise<void>;

  constructor(db: Database) {
    this.db = db;
    this.migrationPromise = runMigrations(db, buildMigrationSteps(), {
      ledger: REQUEST_LOG_LEDGER,
      primaryTable: REQUEST_LOG_TABLE,
    });
  }

  /** Async factory: awaits the same migration run as the constructor. */
  static async create(db: Database): Promise<RequestLogStore> {
    const store = new RequestLogStore(db);
    await store.migrationPromise;
    return store;
  }

  // -- Write -----------------------------------------------------------------

  write(entry: RequestLogEntry): void {
    const createdAt =
      entry.createdAt.getTime() === 0 ? new Date() : entry.createdAt;

    this.db
      .prepare(
        `INSERT INTO request_logs(trace_id, stage, model, provider, prompt_tokens, completion_tokens, total_tokens, error_message, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.traceId,
        entry.stage,
        entry.model,
        entry.provider,
        entry.promptTokens,
        entry.completionTokens,
        entry.totalTokens,
        entry.errorMessage,
        createdAt.toISOString(),
      );
  }

  // -- List ------------------------------------------------------------------

  list(query: RequestLogQuery): RequestLogListResult {
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_LIMIT,
    );
    const offset = Math.max(query.offset ?? 0, 0);

    const { whereSQL, args } = buildWhereClause(query);

    // Count total matching rows
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM request_logs${whereSQL}`)
      .get(...args) as { total: number } | null;
    const total = countRow?.total ?? 0;

    // Fetch paginated rows
    const rows = this.db
      .prepare(
        `SELECT trace_id, stage, model, provider, prompt_tokens, completion_tokens, total_tokens, error_message, created_at
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
    }>;

    const data: RequestLogEntry[] = rows.map((row) => ({
      traceId: row.trace_id ?? "",
      stage: row.stage,
      model: row.model ?? "",
      provider: row.provider ?? "",
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      errorMessage: row.error_message ?? "",
      createdAt: new Date(row.created_at),
    }));

    return { data, total };
  }

  // -- Stats -----------------------------------------------------------------

  stats(query: RequestLogQuery): RequestLogStatsResult {
    const { whereSQL, args } = buildWhereClause(query);

    const statsQuery = STATS_QUERY_TEMPLATE.replaceAll(
      "{whereClause}",
      whereSQL,
    );

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

  close(): void {
    this.db.close();
  }
}
