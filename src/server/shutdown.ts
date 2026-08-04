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
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
    return () => {
      process.off("SIGTERM", handler);
      process.off("SIGINT", handler);
    };
  }
}

export class InFlightTracker {
  private count = 0;

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
