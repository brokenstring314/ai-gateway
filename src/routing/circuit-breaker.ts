import type { CircuitBreakerConfig } from "../config/types.js";

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  override name = "CircuitOpenError";
  constructor(public readonly target: string) {
    super(`Circuit breaker is OPEN for target "${target}"`);
  }
}

const DEFAULT_CB: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  successThreshold: 1,
  timeoutMs: 30000,
};

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;

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

  getState(): BreakerState {
    if (this.state === "OPEN" && Date.now() - this.openedAt >= this.timeoutMs) {
      this.state = "HALF_OPEN";
    }
    return this.state;
  }

  allow(): boolean {
    const state = this.getState();
    return state !== "OPEN";
  }

  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.state = "CLOSED";
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
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
