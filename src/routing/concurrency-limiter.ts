export interface ConcurrencyLimiterOptions {
  maxConcurrency: number;
  queueSize?: number;
}

export class ConcurrencyLimitError extends Error {
  override name = "ConcurrencyLimitError";
  constructor(public readonly target: string) {
    super(`Concurrency limit reached for target "${target}"`);
  }
}

const DEFAULT_QUEUE_SIZE = 1000;

interface Waiter {
  grant(granted: boolean): void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export class ConcurrencyLimiter {
  private inFlightCount = 0;
  private readonly queue: Waiter[] = [];
  private readonly maxConcurrency: number;
  private readonly queueSize: number;
  private closed = false;

  constructor(options: ConcurrencyLimiterOptions) {
    if (options.maxConcurrency < 1) {
      throw new RangeError(`maxConcurrency must be at least 1, got ${options.maxConcurrency}`);
    }
    this.maxConcurrency = options.maxConcurrency;
    this.queueSize = options.queueSize ?? DEFAULT_QUEUE_SIZE;
  }

  get inFlight(): number {
    return this.inFlightCount;
  }

  get queued(): number {
    return this.queue.length;
  }

  /**
   * Take a slot: true (granted now), false (queue full / closed), or a
   * promise for a queued wait that resolves true when a slot is handed over
   * (false when the limiter closes). With a `signal`, a queued wait is
   * abortable: on abort the waiter leaves the queue (it never holds a slot)
   * and the promise rejects with the signal's reason (C3-3).
   */
  acquire(signal?: AbortSignal | null): boolean | Promise<boolean> {
    if (this.closed) return false;

    if (this.inFlightCount < this.maxConcurrency) {
      this.inFlightCount++;
      return true;
    }

    if (this.queue.length >= this.queueSize) {
      return false;
    }

    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(abortReason(signal!));
      };
      const waiter: Waiter = {
        grant: (granted) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(granted);
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    if (this.inFlightCount <= 0) return;

    const next = this.queue.shift();
    if (next) {
      next.grant(true);
      return;
    }

    this.inFlightCount--;
  }

  close(): void {
    this.closed = true;
    let next = this.queue.shift();
    while (next) {
      next.grant(false);
      next = this.queue.shift();
    }
  }
}

export class ConcurrencyLimiterRegistry {
  private readonly limiters = new Map<string, ConcurrencyLimiter>();

  getOrCreate(name: string, options: ConcurrencyLimiterOptions): ConcurrencyLimiter {
    let limiter = this.limiters.get(name);
    if (!limiter) {
      limiter = new ConcurrencyLimiter(options);
      this.limiters.set(name, limiter);
    }
    return limiter;
  }

  get(name: string): ConcurrencyLimiter | undefined {
    return this.limiters.get(name);
  }

  reset(name: string): void {
    this.limiters.delete(name);
  }

  all(): ReadonlyMap<string, ConcurrencyLimiter> {
    return this.limiters;
  }
}
