import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { bodyLimitMiddleware } from "@/middleware/body-limit";

function createApp(maxBytes?: number) {
  const app = new Hono();
  app.use("*", bodyLimitMiddleware(maxBytes));
  app.post("/test", (c) => c.json({ ok: true }, 200));
  app.get("/test", (c) => c.json({ ok: true }, 200));
  return app;
}

describe("bodyLimitMiddleware", () => {
  it("rejects request with Content-Length > limit (413)", async () => {
    const app = createApp(100);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "200" },
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.type).toBe("request_too_large");
  });

  it("allows request within limit", async () => {
    const app = createApp(1000);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "50", "Content-Type": "application/json" },
      body: JSON.stringify({ data: "small" }),
    });
    expect(res.status).toBe(200);
  });

  it("allows GET requests regardless of body", async () => {
    const app = createApp(1);
    const res = await app.request("/test", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("allows HEAD requests regardless of body", async () => {
    const app = createApp(1);
    app.get("/test-head", (c) => c.json({ ok: true }, 200));
    const res = await app.request("/test-head", { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("uses default 10MB when no config", async () => {
    const app = createApp();
    const tenMB = 10 * 1024 * 1024;
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": String(tenMB - 1) },
    });
    expect(res.status).toBe(200);
  });

  it("rejects when Content-Length equals limit exactly", async () => {
    const app = createApp(100);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "101" },
    });
    expect(res.status).toBe(413);
  });

  it("allows when Content-Length equals limit", async () => {
    const app = createApp(100);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "100" },
    });
    expect(res.status).toBe(200);
  });

  it("passes through when Content-Length is not a number", async () => {
    const app = createApp(100);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "not-a-number" },
    });
    expect(res.status).toBe(200);
  });
});
