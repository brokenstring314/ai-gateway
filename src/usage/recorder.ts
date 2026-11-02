/**
 * Usage recorder (0.3.0 P5): turns finished requests into hourly rollups
 * and persists the key meter's used-token counters — asynchronously, in
 * batches, never on the request path.
 *
 * It is a request-log sink (Gateway.addRequestLogSink): the pipeline's
 * finalize hands it one entry per request, which only adds numbers to an
 * in-memory map. A timer (default every second) writes the map to the usage
 * store in one transaction and the changed used-token counters to the key
 * store in another. GET /admin/usage flushes first, so it always sees every
 * finished request; shutdown flushes last.
 */

import type { RequestLogEntry } from "../observability/request-log.js";
import type { KeyStore } from "../persistence/key-store.js";
import type { KeyMeter } from "./key-meter.js";
import { addCounts, emptyCounts, HOUR_MS, type UsageBucket, type UsageCounts, type UsageStore } from "./usage-store.js";

/** Flush early once this many distinct buckets are pending. */
const MAX_PENDING = 5000;

export interface UsageRecorderOptions {
  readonly store: UsageStore;
  /** Live used-token counters to persist (and the key store to write them to). */
  readonly meter?: KeyMeter;
  readonly keyStore?: Pick<KeyStore, "saveUsedTokens">;
  /** Flush interval in ms (default 1000). 0: no timer (tests flush by hand). */
  readonly intervalMs?: number;
}

type Pending = UsageCounts & Pick<UsageBucket, "hour" | "keyId" | "model" | "channel">;

export class UsageRecorder {
  private pending = new Map<string, Pending>();
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  /** The sink to register with Gateway.addRequestLogSink (stable identity). */
  readonly sink = (entry: RequestLogEntry): void => this.record(entry);

  constructor(private readonly opts: UsageRecorderOptions) {
    const interval = opts.intervalMs ?? 1000;
    if (interval > 0) {
      this.timer = setInterval(() => this.flush(), interval);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Add one finished request to its hourly bucket (memory only). */
  record(entry: RequestLogEntry): void {
    if (this.closed) return;
    const at = Date.parse(entry.timestamp);
    const hour = Math.floor((Number.isFinite(at) ? at : Date.now()) / HOUR_MS);
    const keyId = entry.keyId ?? "";
    const model = entry.publishedModel ?? entry.model ?? "";
    // "none" / "unknown": the request never reached an upstream channel.
    const channel = entry.provider && entry.provider !== "unknown" ? entry.provider : "none";
    const k = `${hour}\u0000${keyId}\u0000${model}\u0000${channel}`;
    let b = this.pending.get(k);
    if (!b) {
      b = { hour, keyId, model, channel, ...emptyCounts() };
      this.pending.set(k, b);
    }
    const t = entry.tokens;
    const latency = Number.isFinite(entry.durationMs) && entry.durationMs > 0 ? entry.durationMs : 0;
    addCounts(b, {
      requests: 1,
      errors: isError(entry) ? 1 : 0,
      inputTokens: nonNegative(t?.prompt),
      outputTokens: nonNegative(t?.completion),
      cacheHitTokens: nonNegative(t?.cacheHit),
      reasoningTokens: nonNegative(t?.reasoning),
      estimatedRequests: entry.usageEstimated === true ? 1 : 0,
      latencyMsSum: latency,
      latencyMsMax: latency,
    });
    if (this.pending.size >= MAX_PENDING) this.flush();
  }

  /** Write pending rollups and changed used-token counters now. Never throws. */
  flush(): void {
    if (this.pending.size > 0) {
      const batch = this.pending;
      this.pending = new Map();
      try {
        this.opts.store.add(batch.values());
      } catch (err) {
        console.error(`[usage] could not write usage rollups (kept for the next flush): ${message(err)}`);
        // Merge back (newer increments may already be pending).
        for (const [k, b] of batch) {
          const cur = this.pending.get(k);
          if (cur) addCounts(cur, b);
          else this.pending.set(k, b);
        }
      }
    }
    const meter = this.opts.meter;
    const keyStore = this.opts.keyStore;
    if (meter && keyStore) {
      const used = meter.drainDirty();
      if (used.length > 0) {
        try {
          keyStore.saveUsedTokens(used);
        } catch (err) {
          console.error(`[usage] could not persist used tokens of ${used.length} key(s), will retry: ${message(err)}`);
          meter.markDirty(used.map(([id]) => id));
        }
      }
    }
  }

  /** Final flush and stop the timer (shutdown). */
  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.flush();
    this.closed = true;
  }
}

function isError(entry: RequestLogEntry): boolean {
  return (entry.status !== undefined && entry.status >= 400) || (entry.error !== undefined && entry.error !== "");
}

function nonNegative(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
