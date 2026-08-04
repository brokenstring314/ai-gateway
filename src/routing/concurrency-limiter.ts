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

export class ConcurrencyLimiter {
  private inFlightCount = 0;
  private readonly queue: Array<(granted: boolean) => void> = [];
  private readonly maxConcurrency: number;
  private readonly queueSize: number;
  private closed = false;

  constructor(options: ConcurrencyLimiterOptions) {
    if (options.maxConcurrency < 1) {
      throw new RangeError(
        `maxConcurrency must be at least 1, got ${options.maxConcurrency}`,
      );
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

  acquire(): boolean | Promise<boolean> {
    if (this.closed) return false;

    if (this.inFlightCount < this.maxConcurrency) {
      this.inFlightCount++;
      return true;
    }

    if (this.queue.length >= this.queueSize) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.inFlightCount <= 0) return;

    const next = this.queue.shift();
    if (next) {
      next(true);
      return;
    }

    this.inFlightCount--;
  }

  close(): void {
    this.closed = true;
    let next = this.queue.shift();
    while (next) {
      next(false);
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
