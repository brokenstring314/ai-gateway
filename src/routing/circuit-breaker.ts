import type { CircuitBreakerConfig as BaseCircuitBreakerConfig } from "../config/types.js";

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  override name = "CircuitOpenError";
  constructor(public readonly target: string) {
    super(`Circuit breaker is OPEN for target "${target}"`);
  }
}

/** Token for one admitted attempt, returned by CircuitBreaker.acquire(). */
export interface BreakerPermit {
  /** True when the attempt consumed a HALF_OPEN probe slot. */
  readonly halfOpen: boolean;
  readonly epoch: number;
}

export interface CircuitBreakerConfig extends BaseCircuitBreakerConfig {
  maxHalfThreshold?: number;
}

const DEFAULT_CB: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  successThreshold: 1,
  maxHalfThreshold: 1,
  timeoutMs: 30000,
};

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;
  private halfOpenPermits = 0;
  /** Incremented on every transition into HALF_OPEN, so a stale permit cannot be released into a newer probe window. */
  private halfOpenEpoch = 0;
  /** When the last HALF_OPEN probe permit was handed out (ms epoch). */
  private lastProbeAt = 0;

  constructor(
    public readonly name: string,
    private readonly config: CircuitBreakerConfig = {},
  ) {}

  private get failureThreshold(): number {
    return this.config.failureThreshold ?? DEFAULT_CB.failureThreshold;
  }

  private get successThreshold(): number {
    return this.config.successThreshold ?? DEFAULT_CB.successThreshold;
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_CB.timeoutMs;
  }

  private get maxHalfThreshold(): number {
    return this.config.maxHalfThreshold ?? DEFAULT_CB.maxHalfThreshold;
  }

  getState(): BreakerState {
    if (this.state === "OPEN" && Date.now() - this.openedAt >= this.timeoutMs) {
      this.state = "HALF_OPEN";
      this.halfOpenPermits = this.maxHalfThreshold;
      this.halfOpenEpoch++;
      this.consecutiveSuccesses = 0;
    }
    return this.state;
  }

  allow(): boolean {
    return this.acquire() !== null;
  }

  /**
   * Like allow(), but returns a permit describing the admitted attempt (or
   * null when rejected). Pass the permit to release() when the attempt ends
   * with neither success nor failure, so a HALF_OPEN probe slot is returned.
   */
  acquire(): BreakerPermit | null {
    const state = this.getState();
    if (state === "OPEN") return null;
    if (state === "HALF_OPEN") {
      if (this.halfOpenPermits <= 0) {
        // Safety net: a probe that never reported back (leaked permit) must
        // not wedge the breaker in HALF_OPEN forever. After timeoutMs with no
        // new probe handed out, re-arm the probe window.
        if (Date.now() - this.lastProbeAt < this.timeoutMs) return null;
        this.halfOpenPermits = this.maxHalfThreshold;
        this.halfOpenEpoch++;
      }
      this.halfOpenPermits--;
      this.lastProbeAt = Date.now();
      return { halfOpen: true, epoch: this.halfOpenEpoch };
    }
    return { halfOpen: false, epoch: this.halfOpenEpoch };
  }

  /**
   * Return a permit whose attempt produced no health signal (client abort,
   * local concurrency rejection, caller-caused 4xx, consumer stopped before
   * any output). In HALF_OPEN this gives the probe slot back; otherwise it is
   * a no-op. Without a permit, releases one HALF_OPEN slot if any is taken.
   */
  release(permit?: BreakerPermit | null): void {
    if (this.state !== "HALF_OPEN") return;
    if (permit) {
      if (!permit.halfOpen || permit.epoch !== this.halfOpenEpoch) return;
    }
    if (this.halfOpenPermits < this.maxHalfThreshold) this.halfOpenPermits++;
  }

  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.state = "CLOSED";
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
      } else if (this.halfOpenPermits < this.maxHalfThreshold) {
        // More successful probes are needed: free the slot for the next one.
        this.halfOpenPermits++;
      }
      return;
    }

    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
  }

  recordFailure(): void {
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.openedAt = Date.now();
      this.consecutiveSuccesses = 0;
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      this.consecutiveSuccesses = 0;
    }
  }
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  getOrCreate(name: string, config?: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, config);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  reset(name: string): void {
    this.breakers.delete(name);
  }

  resetAll(): void {
    this.breakers.clear();
  }

  all(): ReadonlyMap<string, CircuitBreaker> {
    return this.breakers;
  }
}
