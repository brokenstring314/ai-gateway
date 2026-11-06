/**
 * Starts one gateway per browser suite (tests/browser/support/server.ts under
 * Bun) with a temporary data dir and GATEWAY_SECRET_KEY, and gives the tests
 * an Admin API client (X-Admin-Secret) plus helpers for the console.
 *
 * Runs inside the Playwright runner (Node), so it only uses node: APIs.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const ADMIN_SECRET = "browser-admin-secret-0123456789";

export interface Gateway {
  readonly base: string;
  readonly dataDir: string;
  logs(): string;
  /** Admin API call with the admin secret; returns status, headers and parsed JSON. */
  admin<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiReply<T>>;
  /** Raw fetch against the gateway. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Mint a key with the admin secret; returns its plaintext. */
  mintKey(name: string, scopes: string[], extra?: Record<string, unknown>): Promise<string>;
  stop(): Promise<void>;
}

export interface ApiReply<T> {
  status: number;
  headers: Headers;
  body: T;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

/** The seed target from the config file (trusted, imported into the store on first start). */
export function seedConfig(extra: Record<string, unknown> = {}) {
  return {
    strategy: { mode: "single", targets: ["seed"] },
    targets: [
      {
        name: "seed",
        provider: "openai",
        apiKey: "sk-seed-upstream-0123456789",
        baseURL: "https://seed.upstream.test/v1",
        models: ["seed-chat"],
      },
    ],
    auth: { enabled: true },
    adminSecret: ADMIN_SECRET,
    requestTimeout: "30s",
    ...extra,
    // A suite signs in from one IP dozens of times a minute; the per-IP limit
    // on successful sign-ins (FA-3, default 20/min) is not what it tests.
    console: { maxLoginsPerMinute: 1000, ...((extra["console"] as Record<string, unknown> | undefined) ?? {}) },
  };
}

export async function startGateway(config: Record<string, unknown> = seedConfig()): Promise<Gateway> {
  const dir = mkdtempSync(join(tmpdir(), "aigw-browser-"));
  const dataDir = join(dir, "data");
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  const port = await freePort();
  const bun = process.env["BUN_BIN"] ?? "bun";
  const proc: ChildProcess = spawn(bun, ["tests/browser/support/server.ts", cfgPath, String(port), dataDir], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GATEWAY_SECRET_KEY: randomBytes(32).toString("base64"),
      RATE_LIMIT_RPS: "100000",
      RATE_LIMIT_BURST: "100000",
      SHUTDOWN_GRACE_MS: "2000",
      USAGE_FLUSH_INTERVAL_MS: "200",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
  proc.stderr?.on("data", (c: Buffer) => (out += c.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline && proc.exitCode === null) {
    try {
      if ((await fetch(`${base}/livez`)).ok) {
        ready = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`gateway did not start on ${base}\n${out}`);
  }

  const gw: Gateway = {
    base,
    dataDir,
    logs: () => out,
    fetch: (path, init) => fetch(`${base}${path}`, init),
    async admin(method, path, body, headers = {}) {
      const res = await fetch(`${base}/admin${path}`, {
        method,
        headers: {
          "X-Admin-Secret": ADMIN_SECRET,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        // not JSON
      }
      return { status: res.status, headers: res.headers, body: parsed as never };
    },
    async mintKey(name, scopes, extra = {}) {
      const r = await gw.admin<{ key: string }>("POST", "/keys", { name, scopes, ...extra });
      if (r.status !== 201) throw new Error(`mint ${name}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.key;
    },
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once("exit", r));
        proc.kill("SIGTERM");
        const t = setTimeout(() => proc.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(t);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return gw;
}

/** Create a channel on a fake upstream (`https://<label>.upstream.test/v1`) through the Admin API. */
export async function createChannel(gw: Gateway, label: string, models: string[] = []): Promise<string> {
  const r = await gw.admin<{ id: string }>("POST", "/channels", {
    name: label,
    preset: "openai",
    baseURL: `https://${label}.upstream.test/v1`,
    keys: [{ key: `sk-${label}-upstream-0123456789` }],
    ...(models.length > 0 ? { models } : {}),
  });
  if (r.status !== 201) throw new Error(`channel ${label}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** Collects console errors, page errors and CSP violations; `assertClean()` fails the test on any. */
export class PageWatch {
  readonly problems: string[] = [];
  constructor(readonly page: Page) {
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      // An expected API rejection (401 on a stale session, 409 conflict, 4xx validation) logs
      // "Failed to load resource"; that is the console doing its job, not a page bug.
      if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
      this.problems.push(`console.error: ${text}`);
    });
    page.on("pageerror", (e) => this.problems.push(`pageerror: ${e.message}`));
  }

  /** Install the securitypolicyviolation listener before any page script runs. */
  static async install(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
  }

  async assertClean(): Promise<void> {
    const csp = await this.page
      .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
      .catch(() => [] as string[]);
    expect([...this.problems, ...csp.map((v) => `CSP violation: ${v}`)]).toEqual([]);
  }
}

/** A fresh context (zh UI, CSP watch) signed in to the console with `key`. */
export async function signedIn(
  browser: Browser,
  gw: Gateway,
  key: string,
  lang: "zh" | "en" = "zh",
): Promise<{ context: BrowserContext; page: Page; watch: PageWatch }> {
  const context = await browser.newContext({ baseURL: gw.base, locale: lang === "zh" ? "zh-CN" : "en-US" });
  await PageWatch.install(context);
  const page = await context.newPage();
  const watch = new PageWatch(page);
  await page.goto("/admin/dashboard");
  await page.locator('input[name="key"]').fill(key);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator("header.top")).toBeVisible();
  return { context, page, watch };
}

/** Navigate with the console's own nav (client-side routing). */
export async function goTo(page: Page, label: string | RegExp): Promise<void> {
  await page.locator("header.top nav").getByRole("link", { name: label }).click();
  await expect(page.locator("main h1")).toHaveText(label);
}

/** Wait for a toast with this text. */
export async function toast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator(".toasts .toast").filter({ hasText: text }).first()).toBeVisible();
}

/** Accept the next confirm() dialog. */
export function acceptConfirm(page: Page): void {
  page.once("dialog", (d) => void d.accept());
}

export async function chat(
  gw: Gateway,
  key: string,
  model: string,
  opts: { stream?: boolean; max_tokens?: number } = {},
): Promise<Response> {
  return gw.fetch("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...opts }),
  });
}
