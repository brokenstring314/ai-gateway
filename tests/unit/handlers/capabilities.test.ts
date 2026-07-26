import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@/app";
import type { Gateway } from "@/gateway";

function createMockGateway(): Gateway {
  return {
    getRegistry: vi.fn().mockReturnValue({
      list: vi.fn().mockReturnValue(["openai"]),
    }),
  } as unknown as Gateway;
}

describe("Capabilities handler", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = new Hono<AppEnv>();
  });

  it("GET /v1/capabilities returns 200 with provider capabilities data", async () => {
    const mockGateway = createMockGateway();
    const { registerCapabilitiesHandler } = await import("@/handlers/capabilities");
    registerCapabilitiesHandler(app, mockGateway);

    const res = await app.request("/v1/capabilities");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toBeDefined();
    expect(body.providers.openai).toBeDefined();
    expect(body.providers.openai.capabilities).toBeInstanceOf(Array);
  });
});
