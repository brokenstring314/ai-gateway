export interface Shutdownable {
  name: string;
  close(): void | Promise<void>;
}

export interface ShutdownManagerOptions {
  shutdownGraceMs?: number;
  logger?: (msg: string) => void;
  inFlightTracker?: InFlightTracker;
}

export class ShutdownManager {
  private readonly components: Shutdownable[] = [];
  private readonly inFlightTracker: InFlightTracker;
  private readonly graceMs: number;
  private readonly logger: (msg: string) => void;
  private shuttingDownFlag = false;
  private stopAcceptingHook: (() => unknown) | null = null;

  constructor(opts: ShutdownManagerOptions = {}) {
    this.graceMs = opts.shutdownGraceMs ?? 10_000;
    this.logger = opts.logger ?? (() => {});
    this.inFlightTracker = opts.inFlightTracker ?? new InFlightTracker();
  }

  get inFlight(): InFlightTracker {
    return this.inFlightTracker;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDownFlag;
  }

  /**
   * Called right after readiness flips to draining and before the drain:
   * stop accepting new connections (e.g. `server.stop(false)`) while
   * in-flight requests keep running. Errors are logged, never thrown.
   */
  setStopAccepting(hook: () => unknown): void {
    this.stopAcceptingHook = hook;
  }

  register(component: Shutdownable): void {
    this.components.push(component);
  }

  async shutdown(reason?: string): Promise<void> {
    if (this.shuttingDownFlag) {
      return;
    }
    this.shuttingDownFlag = true;
    // Flip readiness to 503 and reject new requests before draining, so the
    // load balancer stops sending traffic while in-flight requests finish.
    this.inFlightTracker.startDraining();
    this.logger(`shutdown started: ${reason ?? "unknown reason"}`);
    // Order: readiness 503 -> stop accepting -> drain in-flight -> close components.
    if (this.stopAcceptingHook !== null) {
      try {
        // Not awaited: Bun's stop(false) promise settles only once every
        // connection has closed, which is what the drain below waits for.
        void Promise.resolve(this.stopAcceptingHook()).catch((err: unknown) => {
          this.logger(`failed to stop accepting connections: ${String(err)}`);
        });
      } catch (err) {
        this.logger(`failed to stop accepting connections: ${String(err)}`);
      }
    }
    const drained = await this.inFlightTracker.drain(this.graceMs);
    if (!drained) {
      this.logger(`grace period of ${this.graceMs}ms elapsed with ${this.inFlightTracker.pending} request(s) in flight; closing anyway`);
    }
    for (const component of this.components) {
      try {
        await component.close();
      } catch (err) {
        this.logger(`failed to close component ${component.name}: ${String(err)}`);
      }
    }
  }

  installSignalHandlers(): () => void {
    const handler = (): void => {
      void this.shutdown("signal received");
    };
    // SIGHUP is the conventional "reload" signal. There is no hot reload
    // (removed in 0.2.0), and Bun's default action would kill the process
    // without draining, so log and ignore it.
    const hupHandler = (): void => {
      this.logger("SIGHUP ignored: config hot reload is not supported; restart the gateway to apply config changes");
    };
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
    process.on("SIGHUP", hupHandler);
    return () => {
      process.off("SIGTERM", handler);
      process.off("SIGINT", handler);
      process.off("SIGHUP", hupHandler);
    };
  }
}

export class InFlightTracker {
  private count = 0;
  private drainingFlag = false;

  /** True once shutdown began: /readyz answers 503 and new requests are rejected. */
  get draining(): boolean {
    return this.drainingFlag;
  }

  startDraining(): void {
    this.drainingFlag = true;
  }

  get pending(): number {
    return this.count;
  }

  increment(): void {
    this.count++;
  }

  decrement(): void {
    if (this.count > 0) {
      this.count--;
    }
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (this.count === 0) {
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    while (this.count > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 10)));
    }
    return true;
  }
}
