import type { CircuitBreakerConfig as BaseCircuitBreakerConfig } from "../config/types.js";

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  override name = "CircuitOpenError";
  constructor(
    public readonly target: string,
    /** Seconds until the breaker lets a probe through, when known (Retry-After). */
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Circuit breaker is OPEN for target "${target}"`);
  }
}

/** Token for one admitted attempt, returned by CircuitBreaker.acquire(). */
export interface BreakerPermit {
  /** True when the attempt consumed a HALF_OPEN probe slot. */
  readonly halfOpen: boolean;
  /** HALF_OPEN probe window the permit belongs to. */
  readonly epoch: number;
  /**
   * Breaker generation (bumped on every state transition) when the permit
   * was handed out. Settlement with a permit only counts while the breaker
   * is still in that generation, so an attempt admitted before an outage
   * cannot close, re-open or extend a later state (C3-6).
   */
  readonly generation?: number;
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
  /** Bumped on every state transition (see BreakerPermit.generation). */
  private generation = 0;

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
      this.generation++;
      this.halfOpenPermits = this.maxHalfThreshold;
      this.halfOpenEpoch++;
      this.consecutiveSuccesses = 0;
    }
    return this.state;
  }

  /** Seconds until an OPEN breaker admits a probe (undefined unless OPEN). */
  retryAfterSeconds(): number | undefined {
    if (this.getState() !== "OPEN") return undefined;
    return Math.max(1, Math.ceil((this.openedAt + this.timeoutMs - Date.now()) / 1000));
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
        this.generation++;
      }
      this.halfOpenPermits--;
      this.lastProbeAt = Date.now();
      return { halfOpen: true, epoch: this.halfOpenEpoch, generation: this.generation };
    }
    return { halfOpen: false, epoch: this.halfOpenEpoch, generation: this.generation };
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

  /**
   * Whether a settlement with `permit` belongs to the current state. Without
   * a permit (legacy callers) every outcome counts.
   *  - HALF_OPEN: only probes of the current probe window count;
   *  - OPEN: nothing counts (no permit can be current while OPEN);
   *  - CLOSED: only permits handed out in this CLOSED period count.
   */
  private isCurrent(permit: BreakerPermit | undefined): boolean {
    if (!permit) return true;
    if (permit.generation !== undefined && permit.generation !== this.generation) return false;
    if (this.state === "HALF_OPEN") return permit.halfOpen && permit.epoch === this.halfOpenEpoch;
    if (this.state === "OPEN") return false;
    return !permit.halfOpen;
  }

  private transition(state: BreakerState): void {
    this.state = state;
    this.generation++;
    this.consecutiveSuccesses = 0;
    if (state === "OPEN") this.openedAt = Date.now();
    if (state === "CLOSED") this.consecutiveFailures = 0;
  }

  /** Settle an attempt that succeeded. Pass the attempt's permit (stale permits are ignored). */
  recordSuccess(permit?: BreakerPermit | null): void {
    if (!this.isCurrent(permit ?? undefined)) return;
    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.transition("CLOSED");
      } else if (this.halfOpenPermits < this.maxHalfThreshold) {
        // More successful probes are needed: free the slot for the next one.
        this.halfOpenPermits++;
      }
      return;
    }

    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
  }

  /** Settle an attempt that failed. Pass the attempt's permit (stale permits are ignored). */
  recordFailure(permit?: BreakerPermit | null): void {
    if (!this.isCurrent(permit ?? undefined)) return;
    if (this.state === "HALF_OPEN") {
      this.transition("OPEN");
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.transition("OPEN");
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
