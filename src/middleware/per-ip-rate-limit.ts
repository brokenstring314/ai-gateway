/**
 * Per-IP token bucket rate limiting middleware.
 *
 * Every distinct client IP gets its own token bucket with a configurable
 * sustained rate (`rps`) and burst capacity. Requests that exhaust the
 * bucket are rejected with 429 and a `Retry-After` header. The limiter is
 * OFF unless `rps` is set to a positive number (config
 * `server.perIpRateLimit` or RATE_LIMIT_RPS); `burst` defaults to 2 × rps.
 * Setting `rps` or `burst` to 0 disables it. Idle buckets are swept.
 *
 * The returned middleware also exposes `clear()` and `size()` so callers
 * can reset or observe the bucket store (useful for tests and for
 * preventing unbounded bucket growth).
 */

import type { Context, MiddlewareHandler } from "hono";

interface RequestIpInfo {
  readonly address: string;
}

interface ServerLike {
  readonly requestIP?: (req: Request) => RequestIpInfo | null;
}

type EnvWithServer = ServerLike & {
  /** Legacy shape some adapters use: { server }. */
  readonly server?: ServerLike;
};

/** How often fully refilled (idle) buckets are dropped. */
const SWEEP_INTERVAL_MS = 60_000;

const RATE_LIMIT_BODY = {
  error: {
    message: "Rate limit exceeded",
    type: "rate_limit_error",
    code: "rate_limited",
  },
} as const;

export interface RateLimitOptions {
  /** Sustained requests per second per IP. Unset or 0 disables the limiter. */
  readonly rps?: number;
  /** Token bucket capacity — the maximum burst of requests allowed. Default 2 × rps; 0 disables. */
  readonly burst?: number;
  /** Resolves the client IP from the request context. */
  readonly resolveClientIp?: (c: Context) => string;
  /** Injectable clock (milliseconds) for deterministic tests. */
  readonly nowMs?: () => number;
}

export interface RateLimitMiddleware extends MiddlewareHandler {
  /** Removes all tracked buckets. */
  clear(): void;
  /** Number of IPs currently tracked. */
  size(): number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * The TCP peer address of the request. Bun.serve passes the Server object
 * itself as the second fetch argument, which Hono exposes as `c.env`, so
 * the address is `(c.env as Server).requestIP(req)`. A `{ server }` env is
 * accepted too. Returns "unknown" when no connection info is available
 * (embedded use, app.request in tests).
 */
export function requestRemoteAddress(c: Context): string {
  const env = c.env as EnvWithServer | undefined;
  const candidates: Array<ServerLike | undefined> = [env, env?.server];
  for (const server of candidates) {
    const requestIP = server?.requestIP;
    if (typeof requestIP !== "function") continue;
    try {
      const info = requestIP.call(server, c.req.raw);
      if (info !== null && info !== undefined && info.address !== undefined && info.address !== "") {
        return info.address;
      }
    } catch {
      // Connection info unavailable; try the next shape.
    }
  }
  return "unknown";
}

class TokenBucketStore {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly nowMs: () => number,
  ) {}

  private lastSweepMs = 0;

  /** Consume one token; returns 0 when admitted, else seconds until a token is available. */
  tryConsume(key: string): number {
    const now = this.nowMs();
    this.sweep(now);
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.buckets.set(key, { tokens: this.burst - 1, lastRefillMs: now });
      return 0;
    }
    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    const refill = (elapsedMs / 1000) * this.rps;
    bucket.tokens = Math.min(this.burst, bucket.tokens + refill);
    bucket.lastRefillMs = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.rps));
  }

  /** Drop buckets that have refilled completely: they carry no state. */
  private sweep(now: number): void {
    if (now - this.lastSweepMs < SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    for (const [key, bucket] of this.buckets) {
      const tokens = bucket.tokens + (Math.max(0, now - bucket.lastRefillMs) / 1000) * this.rps;
      if (tokens >= this.burst) this.buckets.delete(key);
    }
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}

export function perIpRateLimitMiddleware(options?: RateLimitOptions): RateLimitMiddleware {
  const rps = options?.rps ?? 0;
  const burst = options?.burst ?? Math.max(1, Math.ceil(rps * 2));
  const nowMs = options?.nowMs ?? Date.now;
  const resolveClientIp = options?.resolveClientIp ?? requestRemoteAddress;

  if (!(rps > 0) || !(burst > 0)) {
    const passThroughHandler: MiddlewareHandler = async (_c, next) => {
      await next();
    };
    return Object.assign(passThroughHandler, { clear: () => {}, size: () => 0 });
  }

  const store = new TokenBucketStore(rps, burst, nowMs);

  const handler: MiddlewareHandler = async (c, next) => {
    const ip = resolveClientIp(c);
    const retryAfter = store.tryConsume(ip);
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      return c.json(RATE_LIMIT_BODY, 429);
    }
    await next();
  };

  return Object.assign(handler, {
    clear: () => store.clear(),
    size: () => store.size,
  });
}
