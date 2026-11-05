/**
 * Console sign-in in a real browser: bad key, scope refusal, lockout, sign
 * out, session ended server-side → back to the sign-in page, language switch
 * persisted, no CSP violation anywhere, CSRF on cookie-authenticated writes.
 */
import { expect, test } from "@playwright/test";
import { type Gateway, PageWatch, goTo, seedConfig, signedIn, startGateway } from "./support/gateway";

test.describe.configure({ mode: "serial" });

let gw: Gateway;
let adminKey: string;
let readOnlyKey: string;
let inferenceKey: string;

test.beforeAll(async () => {
  gw = await startGateway(seedConfig({ console: { maxLoginFailures: 3, lockoutMinutes: 1 } }));
  adminKey = await gw.mintKey("console-admin", ["admin"]);
  readOnlyKey = await gw.mintKey("console-viewer", ["read_only"]);
  inferenceKey = await gw.mintKey("client", ["inference"]);
});
test.afterAll(async () => {
  await gw?.stop();
});

test("bad key and inference-only key are refused with a message on the field", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: gw.base, locale: "zh-CN" });
  await PageWatch.install(context);
  const page = await context.newPage();
  const watch = new PageWatch(page);
  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "登录控制台" })).toBeVisible();
  const input = page.locator('input[name="key"]');
  const submit = page.locator('form button[type="submit"]');
  await expect(submit).toBeDisabled();

  await input.fill("sk-definitely-wrong");
  await submit.click();
  await expect(page.locator(".field-error")).toHaveText("密钥无效");
  await expect(page.locator("label.field.invalid")).toBeVisible();

  await input.fill(inferenceKey);
  await submit.click();
  await expect(page.locator(".field-error")).toContainText("需要 admin 或 read_only");
  await watch.assertClean();
  await context.close();
});

test("read-only key: signs in, sees read-only badge and no write buttons", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, readOnlyKey);
  await expect(page.locator(".who")).toContainText("只读");
  await goTo(page, "密钥");
  await expect(page.getByRole("button", { name: "创建密钥" })).toHaveCount(0);
  await goTo(page, "渠道");
  await expect(page.getByRole("button", { name: "添加渠道" })).toHaveCount(0);
  await watch.assertClean();
  await context.close();
});

test("every page renders with no console error and no CSP violation; sign out returns to sign-in", async ({
  browser,
}) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  for (const label of ["渠道", "模型", "密钥", "用量", "日志", "调试台", "设置", "版本与审计", "概览"]) {
    await goTo(page, label);
    await expect(page.locator("main .error-box")).toHaveCount(0);
  }
  // A full reload of a deep link keeps the session (HttpOnly cookie) and the page.
  await page.goto("/admin/dashboard/usage");
  await expect(page.locator("main h1")).toHaveText("用量");
  // The key never lands in browser storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(adminKey);
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === "aigw_session")?.httpOnly).toBe(true);
  expect(cookies.find((c) => c.name === "aigw_session")?.sameSite).toBe("Strict");

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录控制台" })).toBeVisible();
  // The old cookie is dead server-side too.
  const status = await page.request.get("/admin/status");
  expect(status.status()).toBe(401);
  await watch.assertClean();
  await context.close();
});

test("session ended on the server: the next action shows 会话已过期 and the sign-in page", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  const list = await gw.admin<{ data: Array<{ id: string; current?: boolean }> }>("GET", "/sessions");
  expect(list.status).toBe(200);
  for (const s of list.body.data) await gw.admin("DELETE", `/sessions/${s.id}`);
  await page.locator("header.top nav").getByRole("link", { name: "密钥" }).click();
  await expect(page.locator(".toasts .toast.error")).toHaveText("会话已过期，请重新登录");
  await expect(page.getByRole("heading", { name: "登录控制台" })).toBeVisible();
  // And a cleared cookie (browser-side expiry) lands on the sign-in page on reload.
  await page.locator('input[name="key"]').fill(adminKey);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator("header.top")).toBeVisible();
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole("heading", { name: "登录控制台" })).toBeVisible();
  await watch.assertClean();
  await context.close();
});

test("language switch: zh → en, persists across reload and sign-in", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey, "zh");
  await expect(page.locator("header.top nav")).toContainText("渠道");
  await page.getByLabel("Language / 语言").selectOption("en");
  await expect(page.locator("header.top nav")).toContainText("Channels");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.reload();
  await expect(page.locator("header.top nav")).toContainText("Channels");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to the console" })).toBeVisible();
  await page.getByLabel("Language / 语言").selectOption("zh");
  await expect(page.getByRole("heading", { name: "登录控制台" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "登录控制台" })).toBeVisible();
  await watch.assertClean();
  await context.close();
});

test("CSRF: a cookie-authenticated write without the token is rejected; with it, accepted", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  const results = await page.evaluate(async () => {
    const post = (headers: Record<string, string>) =>
      fetch("/admin/keys", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ name: "csrf-probe", scopes: ["inference"] }),
      }).then(async (r) => ({ status: r.status, body: await r.text() }));
    const token = document.cookie.match(/(?:^|;\s*)aigw_csrf=([^;]+)/)?.[1] ?? "";
    return {
      none: await post({}),
      wrong: await post({ "x-csrf-token": "not-the-token" }),
      right: await post({ "x-csrf-token": token }),
    };
  });
  expect(results.none.status).toBe(403);
  expect(results.wrong.status).toBe(403);
  expect(results.right.status).toBe(201);
  // A cross-site form-style request (no JSON) with the cookie is refused as well.
  const form = await page.request.post("/admin/keys", {
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    data: "name=x",
  });
  expect([403, 415]).toContain(form.status());
  await watch.assertClean();
  await context.close();
});

test("the CSP watch itself works: an injected inline script is blocked and reported", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: gw.base });
  await PageWatch.install(context);
  const page = await context.newPage();
  const watch = new PageWatch(page);
  await page.goto("/admin/dashboard");
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__ran = true";
    document.body.appendChild(s);
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp.length))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined();
  watch.problems.length = 0; // the browser also logs the refusal as a console error
  await context.close();
});

test("lockout: after the configured failures the sign-in page says to wait", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: gw.base, locale: "zh-CN" });
  await PageWatch.install(context);
  const page = await context.newPage();
  const watch = new PageWatch(page);
  await page.goto("/admin/dashboard");
  const input = page.locator('input[name="key"]');
  const submit = page.locator('form button[type="submit"]');
  for (let i = 0; i < 3; i++) {
    await input.fill(`sk-wrong-${i}`);
    await submit.click();
    await expect(page.locator(".field-error")).toBeVisible();
  }
  await input.fill(adminKey);
  await submit.click();
  await expect(page.locator(".field-error")).toContainText(/登录失败次数过多，请 \d+ (秒|分)/);
  await expect(page.locator("header.top")).toHaveCount(0);
  await watch.assertClean();
  await context.close();
});
