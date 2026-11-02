/**
 * Admin console (0.3.0 P6): a Preact single-page app built by Vite from
 * console/ and embedded at build time (assets.generated.ts), so the compiled
 * binary and the Docker image serve it without files on disk and the server
 * gains no runtime dependency.
 *
 *   GET /admin/dashboard, /admin/dashboard/*   index.html (no data; no-store)
 *   GET /admin/dashboard/assets/<hashed name>  JS / CSS (immutable, gzip when accepted)
 *
 * The page carries no gateway data, so it is public; the app signs in with
 * POST /admin/session/login (admin key → HttpOnly session cookie, never kept
 * in the browser) and reads everything from the /admin API. Every response
 * carries a strict CSP: same-origin script/style/fetch only, no inline script
 * or eval, no third-party origin, no framing.
 */

import { Hono } from "hono";
import { gzipSync } from "node:zlib";
import { CONSOLE_ASSETS, CONSOLE_INDEX_HTML } from "./assets.generated.js";

export const CONSOLE_BASE = "/admin/dashboard";

/** CSP for the console page and its assets. */
export const CONSOLE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Headers every console response carries (besides the global security headers). */
export function consoleHeaders(type: string, https: boolean): Record<string, string> {
  return {
    "Content-Type": type,
    "Content-Security-Policy": CONSOLE_CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ...(https ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
}

const gzipCache = new Map<string, Uint8Array>();

function gzipped(name: string, body: string): Uint8Array {
  let z = gzipCache.get(name);
  if (!z) {
    z = gzipSync(Buffer.from(body, "utf8"), { level: 9 });
    gzipCache.set(name, z);
  }
  return z;
}

/** Console routes: the SPA under /admin/dashboard and its hashed assets. */
export function createDashboardApp(): Hono {
  const app = new Hono();
  const isHttps = (url: string) => url.startsWith("https:");

  app.get(`${CONSOLE_BASE}/assets/:name`, (c) => {
    const name = c.req.param("name");
    const asset = CONSOLE_ASSETS[name];
    if (asset === undefined) return c.notFound();
    const headers: Record<string, string> = {
      ...consoleHeaders(asset.type, isHttps(c.req.url)),
      // Hashed file names: a new build has new names.
      "Cache-Control": "public, max-age=31536000, immutable",
      Vary: "Accept-Encoding",
    };
    if (/\bgzip\b/.test(c.req.header("Accept-Encoding") ?? "")) {
      return new Response(gzipped(name, asset.body), { headers: { ...headers, "Content-Encoding": "gzip" } });
    }
    return new Response(asset.body, { headers });
  });

  const page = (url: string) =>
    new Response(CONSOLE_INDEX_HTML, {
      headers: { ...consoleHeaders("text/html; charset=UTF-8", isHttps(url)), "Cache-Control": "no-store" },
    });
  app.get(CONSOLE_BASE, (c) => page(c.req.url));
  app.get(`${CONSOLE_BASE}/*`, (c) => page(c.req.url));
  // The 0.2 console's asset path is gone.
  app.get("/admin/static/*", (c) => c.notFound());
  app.get("/admin", (c) => c.redirect(CONSOLE_BASE, 302));
  app.get("/admin/", (c) => c.redirect(CONSOLE_BASE, 302));
  return app;
}
