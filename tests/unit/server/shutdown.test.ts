import { describe, expect, it, vi } from "bun:test";
import { InFlightTracker, ShutdownManager } from "@/server/shutdown";
import type { Shutdownable } from "@/server/shutdown";

function makeComponent(name: string, close = vi.fn()): Shutdownable {
  return { name, close };
}

describe("ShutdownManager", () => {
  it("closes registered components on shutdown", async () => {
    const component = makeComponent("db");
    const manager = new ShutdownManager();
    manager.register(component);
    await manager.shutdown("test");
    expect(component.close).toHaveBeenCalledTimes(1);
  });

  it("closes multiple components in registration order", async () => {
    const order: string[] = [];
    const a = makeComponent("a", vi.fn(() => order.push("a")));
    const b = makeComponent("b", vi.fn(() => order.push("b")));
    const c = makeComponent("c", vi.fn(() => order.push("c")));
    const manager = new ShutdownManager();
    manager.register(a);
    manager.register(b);
    manager.register(c);
    await manager.shutdown();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("awaits async close before closing the next component", async () => {
    const order: string[] = [];
    const a = makeComponent(
      "a",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("a");
      }),
    );
    const b = makeComponent("b", vi.fn(() => order.push("b")));
    const manager = new ShutdownManager();
    manager.register(a);
    manager.register(b);
    await manager.shutdown();
    expect(order).toEqual(["a", "b"]);
  });

  it("sets isShuttingDown before closing and keeps it set after", async () => {
    let observedDuringClose: boolean | undefined;
    const manager = new ShutdownManager();
    const component = makeComponent(
      "db",
      vi.fn(() => {
        observedDuringClose = manager.isShuttingDown;
      }),
    );
    manager.register(component);
    expect(manager.isShuttingDown).toBe(false);
    await manager.shutdown();
    expect(manager.isShuttingDown).toBe(true);
    expect(observedDuringClose).toBe(true);
  });

  it("ignores repeated shutdown calls", async () => {
    const component = makeComponent("db");
    const manager = new ShutdownManager();
    manager.register(component);
    await Promise.all([manager.shutdown("first"), manager.shutdown("second")]);
    expect(component.close).toHaveBeenCalledTimes(1);
  });

  it("continues closing components when one throws", async () => {
    const failing = makeComponent("failing", vi.fn(() => {
      throw new Error("boom");
    }));
    const ok = makeComponent("ok");
    const manager = new ShutdownManager();
    manager.register(failing);
    manager.register(ok);
    await manager.shutdown();
    expect(ok.close).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight requests to drain before closing", async () => {
    const component = makeComponent("db");
    const manager = new ShutdownManager({ shutdownGraceMs: 500 });
    manager.register(component);
    manager.inFlight.increment();
    const shutdownPromise = manager.shutdown("test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(component.close).not.toHaveBeenCalled();
    manager.inFlight.decrement();
    await shutdownPromise;
    expect(component.close).toHaveBeenCalledTimes(1);
  });

  it("closes components even when in-flight requests outlive the grace period", async () => {
    const component = makeComponent("db");
    const manager = new ShutdownManager({ shutdownGraceMs: 20 });
    manager.register(component);
    manager.inFlight.increment();
    await manager.shutdown();
    expect(manager.inFlight.pending).toBe(1);
    expect(component.close).toHaveBeenCalledTimes(1);
  });

  it("logs shutdown events via the configured logger", async () => {
    const logger = vi.fn();
    const manager = new ShutdownManager({ logger });
    await manager.shutdown("maintenance");
    expect(logger).toHaveBeenCalledWith("shutdown started: maintenance");
  });

  it("installs SIGTERM and SIGINT handlers and returns cleanup that removes them", () => {
    const manager = new ShutdownManager();
    const onSpy = vi.spyOn(process, "on");
    const offSpy = vi.spyOn(process, "off");
    const cleanup = manager.installSignalHandlers();
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    cleanup();
    expect(offSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    onSpy.mockRestore();
    offSpy.mockRestore();
  });

  it("triggers shutdown when a signal is emitted, then exits", async () => {
    const component = makeComponent("db");
    const manager = new ShutdownManager();
    manager.register(component);
    const exits: number[] = [];
    const cleanup = manager.installSignalHandlers((code) => exits.push(code));
    process.emit("SIGINT");
    for (let i = 0; i < 20 && component.close.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(component.close).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(exits).toEqual([0]);
    cleanup();
  });
});

describe("InFlightTracker", () => {
  it("tracks increment and decrement counts", () => {
    const tracker = new InFlightTracker();
    expect(tracker.pending).toBe(0);
    tracker.increment();
    tracker.increment();
    expect(tracker.pending).toBe(2);
    tracker.decrement();
    expect(tracker.pending).toBe(1);
  });

  it("resolves drain immediately when nothing is pending", async () => {
    const tracker = new InFlightTracker();
    await expect(tracker.drain(100)).resolves.toBe(true);
  });

  it("resolves drain once pending requests finish", async () => {
    const tracker = new InFlightTracker();
    tracker.increment();
    const drainPromise = tracker.drain(500);
    setTimeout(() => tracker.decrement(), 20);
    await expect(drainPromise).resolves.toBe(true);
    expect(tracker.pending).toBe(0);
  });

  it("returns false when drain times out", async () => {
    const tracker = new InFlightTracker();
    tracker.increment();
    await expect(tracker.drain(30)).resolves.toBe(false);
    expect(tracker.pending).toBe(1);
  });

  it("never decrements below zero", () => {
    const tracker = new InFlightTracker();
    tracker.decrement();
    expect(tracker.pending).toBe(0);
  });
});

describe("SIGHUP (no hot reload since 0.2.0)", () => {
  it("logs and is ignored: no shutdown, no drain", () => {
    const logs: string[] = [];
    const component = makeComponent("db");
    const manager = new ShutdownManager({ logger: (m) => logs.push(m) });
    manager.register(component);
    const uninstall = manager.installSignalHandlers();
    try {
      process.emit("SIGHUP" as NodeJS.Signals);
      expect(manager.isShuttingDown).toBe(false);
      expect(manager.inFlight.draining).toBe(false);
      expect(component.close).not.toHaveBeenCalled();
      expect(logs.some((m) => m.includes("SIGHUP ignored"))).toBe(true);
    } finally {
      uninstall();
    }
  });
});
