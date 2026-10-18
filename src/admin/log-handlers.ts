/**
 * Admin API — log viewing handlers.
 *
 * GET    /admin/logs       — list persisted request log entries (RequestLogStore);
 *                            filters: stage, model, provider, since, status=error|ok, limit, offset
 * GET    /admin/logs/stats — aggregated stats over persisted request log entries
 * DELETE /admin/logs       — purge persisted request log entries older than `before`
 *
 * The legacy in-memory LogBuffer is preserved; getLogsHandler still accepts one
 * directly for backward compatibility with the original admin wiring.
 */

import type { Context } from "hono";
import type { RequestLogStore } from "@/persistence/request-log-store";

/** A single log entry. */
export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

/** In-memory ring buffer for log entries. */
export class LogBuffer {
  private readonly buffer: LogEntry[];
  private index = 0;
  private filled = false;

  constructor(private readonly capacity: number = 1000) {
    this.buffer = new Array<LogEntry>(capacity);
  }

  /** Push a log entry into the ring buffer. */
  push(entry: LogEntry): void {
    this.buffer[this.index] = entry;
    this.index = (this.index + 1) % this.capacity;
    if (this.index === 0) this.filled = true;
  }

  /** Return all entries in chronological order (oldest first). */
  entries(): readonly LogEntry[] {
    if (!this.filled) {
      return this.buffer.slice(0, this.index);
    }
    // Ring has wrapped: index points to oldest
    const first = this.buffer.slice(this.index);
    const second = this.buffer.slice(0, this.index);
    return [...first, ...second];
  }

  /** Current count of entries. */
  get size(): number {
    return this.filled ? this.capacity : this.index;
  }
}

/** Shared log buffer instance — other modules push to this. */
export const logBuffer = new LogBuffer(1000);

/** Persistent request-log state shared by the log handlers. */
export interface LogHandlerState {
  logStore: RequestLogStore | null;
}

interface LogFilters {
  stage?: string;
  model?: string;
  provider?: string;
  since?: Date;
  status?: "error" | "ok";
}

function parseFilters(c: Context): LogFilters {
  const filters: LogFilters = {};
  const stage = c.req.query("stage");
  const model = c.req.query("model");
  const provider = c.req.query("provider");
  if (stage !== undefined && stage !== "") filters.stage = stage;
  if (model !== undefined && model !== "") filters.model = model;
  if (provider !== undefined && provider !== "") filters.provider = provider;
  const status = c.req.query("status");
  if (status === "error" || status === "ok") filters.status = status;
  const sinceRaw = c.req.query("since");
  if (sinceRaw !== undefined && sinceRaw !== "") {
    const since = new Date(sinceRaw);
    if (!Number.isNaN(since.getTime())) filters.since = since;
  }
  return filters;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

/** GET /admin/logs — list persisted request log entries (or legacy buffer entries). */
export function getLogsHandler(state: LogHandlerState | LogBuffer) {
  return (c: Context) => {
    if (state instanceof LogBuffer) {
      const limit = parsePositiveInt(c.req.query("limit"), 100, 1000);
      const all = state.entries();
      return c.json({ entries: all.slice(-limit), total: all.length });
    }
    if (!state.logStore) {
      return c.json({ entries: [], total: 0 });
    }
    const limit = parsePositiveInt(c.req.query("limit"), 50, 200);
    const offsetRaw = c.req.query("offset");
    const offset = offsetRaw === undefined ? 0 : Math.max(Number(offsetRaw) || 0, 0);
    const { data, total } = state.logStore.list({ limit, offset, ...parseFilters(c) });
    return c.json({ entries: data, total });
  };
}

/** GET /admin/logs/stats — aggregate stats over persisted request log entries. */
export function getLogsStatsHandler(state: LogHandlerState) {
  return (c: Context) => {
    if (!state.logStore) {
      return c.json({
        totalEntries: 0,
        errorEntries: 0,
        totalTokens: 0,
        byStage: {},
        byProvider: {},
        byModel: {},
      });
    }
    return c.json(state.logStore.stats(parseFilters(c)));
  };
}

/** DELETE /admin/logs — purge persisted request log entries older than `before`. */
export function deleteLogsHandler(state: LogHandlerState) {
  return (c: Context) => {
    if (!state.logStore) {
      return c.json({ deleted: 0 });
    }
    const beforeRaw = c.req.query("before");
    if (beforeRaw === undefined || beforeRaw === "") {
      return c.json({ error: "Missing required query parameter: before" }, 400);
    }
    const before = new Date(beforeRaw);
    if (Number.isNaN(before.getTime())) {
      return c.json({ error: "Invalid value for query parameter: before" }, 400);
    }
    const { stage, model, provider } = parseFilters(c);
    const deleted = state.logStore.delete({ before, stage, model, provider });
    return c.json({ deleted });
  };
}
