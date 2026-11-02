/**
 * Usage rollups for the owner (0.3.0 P5): requests, errors, tokens (input,
 * output, cache hit, reasoning) and latency per hour × key × model ×
 * channel, in `usage.sqlite` in the data directory (WAL).
 *
 * Time: buckets are whole UTC hours (`hour` = Unix ms / 3 600 000). GET
 * /admin/usage turns them into calendar days in UTC or in any IANA time
 * zone (`tz`); a bucket belongs to the day its start falls on, so zones
 * with a :30 / :45 offset are accurate to the hour.
 *
 * Writes come from the usage recorder (usage/recorder.ts) in batches, never
 * from the request path. The table is an aggregate: it does not grow with
 * traffic, only with hours × distinct (key, model, channel).
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { type MigrationStep, runMigrations } from "../persistence/migrations.js";

export const HOUR_MS = 3_600_000;

/** One rollup increment (or a stored bucket). Token fields are counts. */
export interface UsageCounts {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  reasoningTokens: number;
  /** Requests whose token counts were estimated (stream without a usage chunk). */
  estimatedRequests: number;
  latencyMsSum: number;
  latencyMsMax: number;
}

export interface UsageBucket extends UsageCounts {
  /** UTC hour: Unix ms / 3 600 000. */
  readonly hour: number;
  /** Key-store key id, `cfg_…` (config auth key), or "" (no key). */
  readonly keyId: string;
  /** Published model name as requested (aliases resolved). */
  readonly model: string;
  /** Channel (target) that served it; "none" when no upstream was called. */
  readonly channel: string;
}

export function emptyCounts(): UsageCounts {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    reasoningTokens: 0,
    estimatedRequests: 0,
    latencyMsSum: 0,
    latencyMsMax: 0,
  };
}

export function addCounts(into: UsageCounts, add: UsageCounts): void {
  into.requests += add.requests;
  into.errors += add.errors;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheHitTokens += add.cacheHitTokens;
  into.reasoningTokens += add.reasoningTokens;
  into.estimatedRequests += add.estimatedRequests;
  into.latencyMsSum += add.latencyMsSum;
  into.latencyMsMax = Math.max(into.latencyMsMax, add.latencyMsMax);
}

const LEDGER = "usage_schema_migrations";

function steps(): MigrationStep[] {
  return [
    {
      version: 1,
      name: "usage_hourly",
      sql: `
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour               INTEGER NOT NULL,
  key_id             TEXT NOT NULL,
  model              TEXT NOT NULL,
  channel            TEXT NOT NULL,
  requests           INTEGER NOT NULL DEFAULT 0,
  errors             INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens   INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  estimated_requests INTEGER NOT NULL DEFAULT 0,
  latency_ms_sum     INTEGER NOT NULL DEFAULT 0,
  latency_ms_max     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, key_id, model, channel)
) WITHOUT ROWID`,
    },
  ];
}

export function usageStorePath(dataDir: string): string {
  return join(dataDir, "usage.sqlite");
}

/** Open the usage database: WAL, synchronous=NORMAL, short busy timeout (writes are batched off the request path). */
export function openUsageDatabase(path: string): Database {
  const db = new Database(path, { create: true, readwrite: true });
  db.exec("PRAGMA busy_timeout = 1000");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // Another connection holds it in rollback mode; keep that.
  }
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

interface Row {
  hour: number;
  key_id: string;
  model: string;
  channel: string;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens: number;
  reasoning_tokens: number;
  estimated_requests: number;
  latency_ms_sum: number;
  latency_ms_max: number;
}

export class UsageStore {
  private constructor(private readonly db: Database) {}

  static async create(db: Database): Promise<UsageStore> {
    await runMigrations(db, steps(), { ledger: LEDGER, primaryTable: "usage_hourly" });
    return new UsageStore(db);
  }

  /** Add increments to their buckets, all in one transaction. */
  add(buckets: Iterable<UsageBucket>): void {
    const stmt = this.db.query(
      `INSERT INTO usage_hourly (hour, key_id, model, channel, requests, errors, input_tokens, output_tokens,
         cache_hit_tokens, reasoning_tokens, estimated_requests, latency_ms_sum, latency_ms_max)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (hour, key_id, model, channel) DO UPDATE SET
         requests = requests + excluded.requests,
         errors = errors + excluded.errors,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_hit_tokens = cache_hit_tokens + excluded.cache_hit_tokens,
         reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
         estimated_requests = estimated_requests + excluded.estimated_requests,
         latency_ms_sum = latency_ms_sum + excluded.latency_ms_sum,
         latency_ms_max = MAX(latency_ms_max, excluded.latency_ms_max)`,
    );
    this.db.transaction(() => {
      for (const b of buckets) {
        stmt.run(
          b.hour,
          b.keyId,
          b.model,
          b.channel,
          b.requests,
          b.errors,
          Math.round(b.inputTokens),
          Math.round(b.outputTokens),
          Math.round(b.cacheHitTokens),
          Math.round(b.reasoningTokens),
          b.estimatedRequests,
          Math.round(b.latencyMsSum),
          Math.round(b.latencyMsMax),
        );
      }
    })();
  }

  /** Buckets with fromHour ≤ hour < toHour (UTC hours). */
  range(fromHour: number, toHour: number): UsageBucket[] {
    const rows = this.db
      .query("SELECT * FROM usage_hourly WHERE hour >= ? AND hour < ? ORDER BY hour")
      .all(fromHour, toHour) as Row[];
    return rows.map((r) => ({
      hour: r.hour,
      keyId: r.key_id,
      model: r.model,
      channel: r.channel,
      requests: r.requests,
      errors: r.errors,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheHitTokens: r.cache_hit_tokens,
      reasoningTokens: r.reasoning_tokens,
      estimatedRequests: r.estimated_requests,
      latencyMsSum: r.latency_ms_sum,
      latencyMsMax: r.latency_ms_max,
    }));
  }

  ping(): void {
    this.db.query("SELECT 1").get();
  }

  close(): void {
    this.db.close();
  }
}
