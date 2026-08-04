/**
 * Per-IP token bucket rate limiting middleware.
 *
 * Every distinct client IP gets its own token bucket with a configurable
 * sustained rate (`rps`) and burst capacity. Requests that exhaust the
 * bucket are rejected with 429. Setting `rps` or `burst` to 0 disables the
 * limiter entirely.
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

type EnvWithServer = {
  readonly server?: ServerLike;
};

const DEFAULT_RPS = 20;
const DEFAULT_BURST = 40;

const RATE_LIMIT_BODY = {
  error: {
    message: "Rate limit exceeded",
    type: "rate_limit_error",
    code: "rate_limited",
  },
} as const;

export interface RateLimitOptions {
  /** Sustained requests per second per IP. 0 disables the limiter. */
  readonly rps?: number;
  /** Token bucket capacity — the maximum burst of requests allowed. 0 disables. */
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

function defaultResolveClientIp(c: Context): string {
  // Bun's Bun.serve() exposes the server (with requestIP) via the fetch env;
  // duck-typing keeps this portable across runtimes and test environments.
  const env = c.env as EnvWithServer | undefined;
  const requestIP = env?.["server"]?.requestIP;
  if (typeof requestIP === "function") {
    try {
      const info = requestIP(c.req.raw);
      if (info !== null && info.address !== undefined && info.address !== "") {
        return info.address;
      }
    } catch {
      // Connection info unavailable; fall through.
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

  tryConsume(key: string): boolean {
    const now = this.nowMs();
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.buckets.set(key, { tokens: this.burst - 1, lastRefillMs: now });
      return true;
    }
    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    const refill = (elapsedMs / 1000) * this.rps;
    bucket.tokens = Math.min(this.burst, bucket.tokens + refill);
    bucket.lastRefillMs = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}

export function perIpRateLimitMiddleware(options?: RateLimitOptions): RateLimitMiddleware {
  const rps = options?.rps ?? DEFAULT_RPS;
  const burst = options?.burst ?? DEFAULT_BURST;
  const nowMs = options?.nowMs ?? Date.now;
  const resolveClientIp = options?.resolveClientIp ?? defaultResolveClientIp;

  if (rps <= 0 || burst <= 0) {
    const passThroughHandler: MiddlewareHandler = async (_c, next) => {
      await next();
    };
    return Object.assign(passThroughHandler, { clear: () => {}, size: () => 0 });
  }

  const store = new TokenBucketStore(rps, burst, nowMs);

  const handler: MiddlewareHandler = async (c, next) => {
    const ip = resolveClientIp(c);
    if (!store.tryConsume(ip)) {
      return c.json(RATE_LIMIT_BODY, 429);
    }
    await next();
  };

  return Object.assign(handler, {
    clear: () => store.clear(),
    size: () => store.size,
  });
}
