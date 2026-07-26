import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "@/middleware/auth";
import type { AppEnv } from "@/app";

function createApp(config?: { enabled?: boolean; keys?: string[] }) {
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware(config));
  app.get("/health", (c) => c.json({ ok: true }, 200));
  app.get("/metrics", (c) => c.json({ ok: true }, 200));
  app.get("/admin", (c) => c.json({ ok: true }, 200));
  app.get("/admin/config", (c) => c.json({ ok: true }, 200));
  app.post("/v1/chat/completions", (c) => c.json({ ok: true }, 200));
  return app;
}

describe("authMiddleware", () => {
  it("rejects missing Authorization header (401)", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("missing_authorization");
  });

  it("rejects invalid format (401)", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Basic sk-test" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_authorization");
  });

  it("rejects wrong API key (401)", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-wrong" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("accepts valid API key", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-test" },
    });
    expect(res.status).toBe(200);
  });

  it("skips /health path", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("skips /metrics path", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
  });

  it("skips /admin path", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/admin");
    expect(res.status).toBe(200);
  });

  it("skips /admin/* paths", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/admin/config");
    expect(res.status).toBe(200);
  });

  it("passes through when auth disabled", async () => {
    const app = createApp({ enabled: false, keys: ["sk-test"] });
    const res = await app.request("/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("passes through when no keys configured", async () => {
    const app = createApp({ enabled: true, keys: [] });
    const res = await app.request("/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("passes through when config is undefined", async () => {
    const app = createApp();
    const res = await app.request("/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("accepts Bearer token with case-insensitive prefix", async () => {
    const app = createApp({ enabled: true, keys: ["sk-test"] });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "bearer sk-test" },
    });
    expect(res.status).toBe(200);
  });

  it("handles different-length keys correctly (no timing leak via Set.has)", async () => {
    const app = createApp({ enabled: true, keys: ["sk-short", "sk-a-very-long-key-with-many-characters"] });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-short" },
    });
    expect(res.status).toBe(200);

    const res2 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-a-very-long-key-with-many-characters" },
    });
    expect(res2.status).toBe(200);
  });
});
