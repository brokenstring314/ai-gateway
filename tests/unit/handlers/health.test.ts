import { describe, it, expect, vi, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/app";
import type { Gateway } from "@/gateway";

function createMockGateway(hasProviders = true): Gateway {
  return {
    getRegistry: vi.fn().mockReturnValue({
      size: hasProviders ? 1 : 0,
    }),
    getConfig: vi.fn().mockReturnValue({ strategy: { mode: "single" } }),
  } as unknown as Gateway;
}

describe("Health probes", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = new Hono<AppEnv>();
  });

  it("GET /health returns 200 with { status: 'ok' }", async () => {
    const { registerHealthHandler } = await import("@/handlers/health");
    registerHealthHandler(app);

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /livez returns 200", async () => {
    const { registerLivenessHandler } = await import("@/handlers/health");
    registerLivenessHandler(app);

    const res = await app.request("/livez");
    expect(res.status).toBe(200);
  });

  it("GET /readyz returns 200 when providers registered", async () => {
    const mockGateway = createMockGateway(true);
    const { registerReadinessHandler } = await import("@/handlers/health");
    registerReadinessHandler(app, mockGateway);

    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /readyz returns 503 when no providers registered", async () => {
    const mockGateway = createMockGateway(false);
    const { registerReadinessHandler } = await import("@/handlers/health");
    registerReadinessHandler(app, mockGateway);

    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("not ready");
  });
});
