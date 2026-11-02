// Admin console (0.3.0 P6): the embedded Preact SPA, its assets and its headers.
import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { CONSOLE_CSP, createDashboardApp } from "@/dashboard";
import { CONSOLE_ASSETS, CONSOLE_INDEX_HTML } from "@/dashboard/assets.generated";

const app = createDashboardApp();
const assetRefs = [...CONSOLE_INDEX_HTML.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);

describe("admin console (embedded SPA)", () => {
  it.each([
    "/admin/dashboard",
    "/admin/dashboard/",
    "/admin/dashboard/channels",
    "/admin/dashboard/models",
    "/admin/dashboard/keys",
    "/admin/dashboard/usage",
    "/admin/dashboard/logs",
    "/admin/dashboard/playground",
    "/admin/dashboard/settings",
    "/admin/dashboard/versions",
  ])("serves the app shell at %s with the strict CSP, no-store", async (path: string) => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toBe(CONSOLE_CSP);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    expect(await res.text()).toBe(CONSOLE_INDEX_HTML);
  });

  it("sends HSTS on https", async () => {
    const res = await app.request("https://gw.example/admin/dashboard");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("CSP: same-origin script/style/fetch only, no inline, no eval, no framing", () => {
    expect(CONSOLE_CSP).toContain("default-src 'none'");
    expect(CONSOLE_CSP).toContain("script-src 'self'");
    expect(CONSOLE_CSP).toContain("connect-src 'self'");
    expect(CONSOLE_CSP).toContain("frame-ancestors 'none'");
    expect(CONSOLE_CSP).toContain("base-uri 'none'");
    expect(CONSOLE_CSP).not.toContain("unsafe-inline");
    expect(CONSOLE_CSP).not.toContain("unsafe-eval");
    expect(CONSOLE_CSP).not.toMatch(/https?:/);
  });

  it("index.html has no inline script or handler and references only embedded assets", () => {
    expect(CONSOLE_INDEX_HTML).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(CONSOLE_INDEX_HTML).not.toMatch(/\son[a-z]+=/i);
    expect(assetRefs.length).toBeGreaterThanOrEqual(2);
    for (const ref of assetRefs) {
      expect(ref.startsWith("/admin/dashboard/assets/")).toBe(true);
      expect(CONSOLE_ASSETS[ref.slice("/admin/dashboard/assets/".length)]).toBeDefined();
    }
  });

  it("every embedded asset is referenced (no dead files)", () => {
    for (const name of Object.keys(CONSOLE_ASSETS)) {
      expect(assetRefs).toContain(`/admin/dashboard/assets/${name}`);
    }
  });

  it("built JS has no eval / new Function and no third-party origin", () => {
    for (const [name, a] of Object.entries(CONSOLE_ASSETS)) {
      if (!name.endsWith(".js")) continue;
      expect(a.body).not.toMatch(/\beval\(|new Function\(/);
      expect(a.body).not.toMatch(/https?:\/\/(?!www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}\//i);
    }
  });

  it("serves hashed assets immutable, gzip when accepted", async () => {
    for (const ref of assetRefs) {
      const plain = await app.request(ref);
      expect(plain.status).toBe(200);
      expect(plain.headers.get("Cache-Control")).toContain("immutable");
      expect(plain.headers.get("Content-Security-Policy")).toBe(CONSOLE_CSP);
      const body = await plain.text();
      const zipped = await app.request(ref, { headers: { "Accept-Encoding": "gzip, br" } });
      expect(zipped.headers.get("Content-Encoding")).toBe("gzip");
      expect(gunzipSync(new Uint8Array(await zipped.arrayBuffer())).toString("utf8")).toBe(body);
    }
  });

  it("unknown assets and the 0.2 asset path are 404", async () => {
    expect((await app.request("/admin/dashboard/assets/nope.js")).status).toBe(404);
    expect((await app.request("/admin/static/console.js")).status).toBe(404);
    expect((await app.request("/admin/static/console.css")).status).toBe(404);
  });

  it("/admin redirects to the console", async () => {
    const res = await app.request("/admin");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/dashboard");
  });
});
