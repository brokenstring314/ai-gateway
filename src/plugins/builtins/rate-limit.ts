import type { IPlugin, PluginContext, PluginResult } from "../types.js";

export interface RateLimitConfig {
  readonly maxRequestsPerMinute: number;
  readonly maxRequestsPerDay?: number;
  readonly key?: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How often idle keys are swept from the map. */
const SWEEP_INTERVAL_MS = MINUTE_MS;

/**
 * Fixed-window counter: `count` requests admitted since `start`; the window
 * resets once `length` ms have passed. O(1) time and memory per key.
 */
interface FixedWindow {
  start: number;
  count: number;
}

interface KeyState {
  minute: FixedWindow;
  /** Only tracked when maxRequestsPerDay is configured. */
  day: FixedWindow | null;
}

function roll(window: FixedWindow, now: number, length: number): void {
  if (now - window.start >= length) {
    window.start = now;
    window.count = 0;
  }
}

/**
 * Per-key request limits with fixed-window counters (one per minute, one per
 * day when a daily limit is set). A window starts at the key's first request
 * in it, so a burst straddling a window boundary can admit up to twice the
 * limit — the usual fixed-window trade-off for O(1) cost. Keys whose windows
 * have all expired are swept periodically.
 */
export class RateLimitPlugin implements IPlugin {
  readonly name = "rate-limit";
  readonly stage = "before_request" as const;
  private readonly windows = new Map<string, KeyState>();
  private lastSweep = 0;

  constructor(private readonly config: RateLimitConfig) {}

  async execute(ctx: PluginContext): Promise<PluginResult> {
    const identifier = this.getIdentifier(ctx);
    const now = Date.now();
    this.sweepIdle(now);
    const state = this.getOrCreateState(identifier, now);

    roll(state.minute, now, MINUTE_MS);
    if (state.day !== null) roll(state.day, now, DAY_MS);

    if (state.minute.count >= this.config.maxRequestsPerMinute) {
      return {
        action: "reject",
        reason: `Rate limit exceeded: ${String(this.config.maxRequestsPerMinute)} requests per minute`,
      };
    }

    const maxPerDay = this.config.maxRequestsPerDay;
    if (maxPerDay !== undefined && state.day !== null && state.day.count >= maxPerDay) {
      return {
        action: "reject",
        reason: `Rate limit exceeded: ${String(maxPerDay)} requests per day`,
      };
    }

    // Record this request
    state.minute.count += 1;
    if (state.day !== null) state.day.count += 1;

    return { action: "continue" };
  }

  /** Number of keys currently tracked (for tests and diagnostics). */
  get trackedKeys(): number {
    return this.windows.size;
  }

  private getIdentifier(ctx: PluginContext): string {
    const apiKey = ctx.metadata["api_key"];
    if (typeof apiKey === "string") return apiKey;
    return this.config.key ?? "default";
  }

  private getOrCreateState(identifier: string, now: number): KeyState {
    const existing = this.windows.get(identifier);
    if (existing !== undefined) return existing;
    const state: KeyState = {
      minute: { start: now, count: 0 },
      day: this.config.maxRequestsPerDay !== undefined ? { start: now, count: 0 } : null,
    };
    this.windows.set(identifier, state);
    return state;
  }

  /** Drop keys whose minute (and day, if tracked) windows have expired. */
  private sweepIdle(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, state] of this.windows) {
      const minuteExpired = now - state.minute.start >= MINUTE_MS;
      const dayExpired = state.day === null || now - state.day.start >= DAY_MS;
      if (minuteExpired && dayExpired) this.windows.delete(key);
    }
  }
}
