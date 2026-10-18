// C3-7 / B3-9 regression: on shutdown the gateway flips readiness, stops
// accepting new connections BEFORE draining, finishes in-flight requests
// (with Connection: close), then closes components.
import { describe, expect, it } from "bun:test";
import { createApp } from "@/app";
import { Gateway } from "@/gateway";
import { ShutdownManager } from "@/server/shutdown";
import type { GatewayConfig } from "@/config/types";

describe("shutdown order", () => {
  it("draining flag -> stopAccepting -> drain -> components", async () => {
    const order: string[] = [];
    const manager = new ShutdownManager({ shutdownGraceMs: 500 });
    manager.setStopAccepting(() => order.push(`stop-accepting(draining=${manager.inFlight.draining})`));
    manager.register({ name: "db", close: () => { order.push("close-db"); } });
    manager.inFlight.increment();
    setTimeout(() => {
      order.push("request-done");
      manager.inFlight.decrement();
    }, 30);
    await manager.shutdown("test");
    expect(order).toEqual(["stop-accepting(draining=true)", "request-done", "close-db"]);
  });

  it("a throwing stopAccepting hook does not block the drain or component close", async () => {
    const logs: string[] = [];
    const manager = new ShutdownManager({ logger: (m) => logs.push(m) });
    let closed = false;
    manager.setStopAccepting(() => { throw new Error("boom"); });
    manager.register({ name: "x", close: () => { closed = true; } });
    await manager.shutdown();
    expect(closed).toBe(true);
    expect(logs.some((m) => m.includes("failed to stop accepting"))).toBe(true);
  });

  it("real server: new connections refused, in-flight request completes with Connection: close", async () => {
    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["mock"] },
      targets: [{ name: "mock", provider: "openai", apiKey: "sk-x", baseURL: "http://127.0.0.1:1/v1", models: ["m"] }],
      auth: { enabled: false },
    };
    const manager = new ShutdownManager({ shutdownGraceMs: 2000 });
    const app = createApp(new Gateway(config), config, undefined, undefined, { inFlightTracker: manager.inFlight });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    app.get("/slow", async (c) => {
      await gate;
      return c.text("done");
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    manager.setStopAccepting(() => server.stop(false));
    manager.register({ name: "http", close: () => server.stop() });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const inflight = fetch(`${base}/slow`);
      await new Promise((r) => setTimeout(r, 50));
      const shutdown = manager.shutdown("test");
      await new Promise((r) => setTimeout(r, 50));
      // Listener closed: a fresh connection is refused (not admitted).
      const fresh = await fetch(`${base}/livez`, { headers: { Connection: "close" } }).then((r) => r.status, () => "refused");
      expect(fresh).toBe("refused");
      release();
      const res = await inflight;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("done");
      expect(res.headers.get("connection")).toBe("close");
      await shutdown;
    } finally {
      server.stop(true);
    }
  });
});
