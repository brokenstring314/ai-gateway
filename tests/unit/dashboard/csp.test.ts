import { describe, expect, it } from "bun:test";
import { createDashboardApp, renderDashboardPage } from "@/dashboard";

const pages = [
  "/admin/dashboard",
  "/admin/dashboard/keys",
  "/admin/dashboard/logs",
  "/admin/dashboard/config",
  "/admin/dashboard/providers",
  "/admin/dashboard/analytics",
  "/admin/dashboard/playground",
  "/admin/dashboard/getting-started",
] as const;

describe("dashboard CSP and server-rendered pages", () => {
  const app = createDashboardApp();

  it.each(pages)("returns 200 for %s", async (path) => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
  });

  it("includes a title and navigation", async () => {
    const body = await (await app.request("/admin/dashboard")).text();
    expect(body).toContain("<title>Gateway overview · Gateway</title>");
    expect(body).toContain("Gateway overview");
    expect(body).toContain("/admin/dashboard/keys");
    expect(body).toContain("Request logs");
  });

  it("sets the exact CSP on pages and assets", async () => {
    const expected = "default-src 'self'; script-src 'self'; style-src 'self'";
    for (const path of ["/admin/dashboard", "/admin/dashboard/login", "/admin/static/style.css", "/admin/static/dashboard.js"]) {
      expect((await app.request(path)).headers.get("Content-Security-Policy")).toBe(expected);
    }
  });

  it("keeps executable behavior external", () => {
    const body = renderDashboardPage("overview");
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(body).not.toMatch(/\son[a-z]+\s*=/i);
    expect(body).not.toContain("javascript:");
    expect(body).toContain('src="/admin/static/dashboard.js"');
  });

  it("serves external CSS and JavaScript", async () => {
    const css = await app.request("/admin/static/style.css");
    const js = await app.request("/admin/static/dashboard.js");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await css.text()).length).toBeGreaterThan(500);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
  });

  it("provides a login page", async () => {
    const body = await (await app.request("/admin/dashboard/login")).text();
    expect(body).toContain("Welcome back.");
    expect(body).toContain('type="password"');
  });

  it("escapes dynamic text", () => {
    const body = renderDashboardPage("overview", { accountName: '<script>alert("x")</script>' });
    expect(body).not.toContain('<script>alert("x")</script>');
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});
