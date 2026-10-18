/**
 * Admin console — a small server-rendered shell plus vanilla JS.
 *
 * The HTML pages carry no gateway data, so they are served without auth:
 * the browser cannot attach a Bearer header to a navigation. All data is
 * loaded by /admin/static/console.js from the authenticated admin API
 * (`Authorization: Bearer <key>`, the key typed on the login page and kept in
 * sessionStorage). No cookies, no inline script, no external assets; every
 * page and asset carries a strict CSP.
 *
 * Pages: overview, keys, logs, config, login.
 */

import { Hono } from "hono";
import { html } from "hono/html";
// Assets are embedded at build time (text imports), so a `bun build --compile`
// binary serves them without the source tree on disk. console.js resolves as a
// JS module for tsc (allowJs), hence the cast; at runtime it is the file text.
import consoleJsText from "./static/console.js" with { type: "text" };
import consoleCss from "./static/console.css" with { type: "text" };

/** CSP for every console page and asset: same-origin script/style/fetch only. */
export const CONSOLE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export type DashboardPage = "overview" | "keys" | "logs" | "config" | "login";

const TITLES: Record<DashboardPage, string> = {
  overview: "Overview",
  keys: "API keys",
  logs: "Request logs",
  config: "Config",
  login: "Sign in",
};

const NAV: ReadonlyArray<DashboardPage> = ["overview", "keys", "logs", "config"];

/** URL of a console page. */
export function routeFor(page: DashboardPage): string {
  return page === "overview" ? "/admin/dashboard" : `/admin/dashboard/${page}`;
}

const ASSETS: Record<string, { body: string; type: string }> = {
  "console.js": { body: consoleJsText as unknown as string, type: "text/javascript; charset=UTF-8" },
  "console.css": { body: consoleCss, type: "text/css; charset=UTF-8" },
};

/** Render a console page shell. Contains no gateway data; `productName` is escaped. */
export function renderDashboardPage(page: DashboardPage, productName = "AI Gateway"): string {
  const title = TITLES[page];
  const head = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · ${productName}</title><link rel="stylesheet" href="/admin/static/console.css"><script src="/admin/static/console.js" defer></script></head>`;
  if (page === "login") {
    return String(
      html`${head}<body data-page="login"><main class="login"><h1>${productName} console</h1><form id="login-form" method="post" action="/admin/dashboard/login" autocomplete="off"><label for="admin-key">Admin or read-only API key</label><input id="admin-key" name="key" type="password" required spellcheck="false"><button type="submit">Sign in</button><p id="login-error" class="error" role="alert" hidden></p></form><p class="hint">The key is kept in this tab's sessionStorage only and sent as <code>Authorization: Bearer</code>. Requires JavaScript.</p></main></body></html>`,
    );
  }
  const nav = NAV.map(
    (p) =>
      html`<a href="${routeFor(p)}"${p === page ? html` class="active" aria-current="page"` : ""}>${TITLES[p]}</a>`,
  );
  return String(
    html`${head}<body data-page="${page}"><header class="top"><strong>${productName}</strong><nav>${nav}</nav><span id="whoami" class="who"></span><button id="logout" type="button" class="link">Sign out</button></header><main><h1>${title}</h1><p id="status" class="status" role="status"></p><div id="app"><noscript>The console needs JavaScript.</noscript></div></main></body></html>`,
  );
}

/** POST login without JS must not echo or keep the key anywhere. */
const LOGIN_POST_BODY = "The console needs JavaScript. Go back and enable it; the key was not stored.";

/** Console routes: page shells under /admin/dashboard, assets under /admin/static. */
export function createDashboardApp(options: { productName?: string } = {}): Hono {
  const app = new Hono();
  const productName = options.productName ?? "AI Gateway";
  const headers = (type: string) => ({
    "Content-Type": type,
    "Content-Security-Policy": CONSOLE_CSP,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  for (const page of [...NAV, "login"] as DashboardPage[]) {
    app.get(
      routeFor(page),
      () => new Response(renderDashboardPage(page, productName), { headers: headers("text/html; charset=UTF-8") }),
    );
  }
  app.post(
    "/admin/dashboard/login",
    () => new Response(LOGIN_POST_BODY, { status: 400, headers: headers("text/plain; charset=UTF-8") }),
  );
  app.get("/admin/static/:name", (c) => {
    const asset = ASSETS[c.req.param("name")];
    if (asset === undefined) return c.notFound();
    return new Response(asset.body, { headers: headers(asset.type) });
  });
  return app;
}
