import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONSOLE_CSP, createDashboardApp, renderDashboardPage } from "@/dashboard";

const PAGES = ["/admin/dashboard", "/admin/dashboard/keys", "/admin/dashboard/logs", "/admin/dashboard/config"];
const JS = readFileSync(join(import.meta.dir, "../../../src/dashboard/static/console.js"), "utf8");

describe("admin console routes", () => {
  const app = createDashboardApp();

  it.each([...PAGES, "/admin/dashboard/login"])("serves %s with the strict CSP, no-store", async (path: string) => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(CONSOLE_CSP);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("CSP allows only same-origin script, style and fetch", () => {
    expect(CONSOLE_CSP).toContain("default-src 'none'");
    expect(CONSOLE_CSP).toContain("script-src 'self'");
    expect(CONSOLE_CSP).toContain("connect-src 'self'");
    expect(CONSOLE_CSP).toContain("frame-ancestors 'none'");
    expect(CONSOLE_CSP).not.toContain("unsafe-inline");
    expect(CONSOLE_CSP).not.toContain("unsafe-eval");
  });

  it.each([
    "/admin/dashboard/providers",
    "/admin/dashboard/analytics",
    "/admin/dashboard/playground",
    "/admin/dashboard/getting-started",
  ])("placeholder page %s is removed", async (path: string) => {
    expect((await app.request(path)).status).toBe(404);
  });

  it("serves only the two allowlisted assets", async () => {
    const js = await app.request("/admin/static/console.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("Content-Type")).toContain("text/javascript");
    expect(js.headers.get("Content-Security-Policy")).toBe(CONSOLE_CSP);
    const css = await app.request("/admin/static/console.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toContain("text/css");
    for (const bad of ["/admin/static/index.ts", "/admin/static/..%2Findex.ts", "/admin/static/dashboard.js"]) {
      expect((await app.request(bad)).status).toBe(404);
    }
  });

  it("does not leak the CSP header onto unrelated routes", async () => {
    const res = await app.request("/v1/models");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("a no-JS login POST does not echo the key", async () => {
    const res = await app.request("/admin/dashboard/login", {
      method: "POST",
      body: new URLSearchParams({ key: "sk-secret-value" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("sk-secret-value");
  });
});

describe("console shell markup", () => {
  it.each(["overview", "keys", "logs", "config", "login"] as const)("%s has no inline script or handlers", (page) => {
    const body = renderDashboardPage(page);
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(body).not.toMatch(/\son[a-z]+\s*=/i);
    expect(body).not.toContain("javascript:");
    expect(body).not.toMatch(/https?:\/\//); // no external assets / CDNs
    expect(body).toContain('src="/admin/static/console.js"');
    expect(body).toContain(`data-page="${page}"`);
  });

  it("navigation lists exactly the four real pages", () => {
    const body = renderDashboardPage("overview");
    for (const href of PAGES) expect(body).toContain(`href="${href}"`);
    expect(body).not.toContain("playground");
    expect(body).toContain('aria-current="page"');
  });

  it("login form posts (never GET: the key must not land in a URL) and uses a password field", () => {
    const body = renderDashboardPage("login");
    expect(body).toContain('method="post"');
    expect(body).toContain('type="password"');
  });

  it("escapes the product name", () => {
    const body = renderDashboardPage("overview", '<script>alert("x")</script>');
    expect(body).not.toContain('<script>alert("x")</script>');
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});

describe("console.js safety", () => {
  it("never writes HTML from strings", () => {
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      expect(JS).not.toContain(sink);
    }
  });

  it("keeps the key in sessionStorage only and sends it as a Bearer header without cookies", () => {
    expect(JS).toContain("sessionStorage");
    expect(JS).not.toContain("localStorage");
    expect(JS).not.toContain("document.cookie");
    expect(JS).toContain("Authorization: `Bearer ${");
    expect(JS).toContain('credentials: "omit"');
  });

  it("is valid JavaScript", () => {
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(JS)).not.toThrow();
  });
});
