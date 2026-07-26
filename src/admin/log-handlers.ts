/**
 * Admin API — log viewing handlers.
 *
 * GET /admin/logs — return recent log entries from an in-memory ring buffer.
 */

import type { Context } from "hono";

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

/** GET /admin/logs — return recent log entries.
 *  Query params: ?limit=N (default 100, max 1000) */
export function getLogsHandler(buffer: LogBuffer) {
  return (c: Context) => {
    const limitParam = c.req.query("limit");
    const limit = Math.min(Math.max(Number(limitParam ?? "100") || 100, 1), 1000);
    const all = buffer.entries();
    const entries = all.slice(-limit);
    return c.json({ entries, total: all.length });
  };
}
