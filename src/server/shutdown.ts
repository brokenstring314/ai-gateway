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
    await this.inFlightTracker.drain(this.graceMs);
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
