/**
 * The console's main flows end to end in a real browser (0.3.0 P7):
 * add channel (wizard) → publish models → edit model / reorder bindings →
 * issue a key → call /v1 with it → usage and quota → playground → versions,
 * rollback and audit → sessions. Every step asserts that the change is live
 * on the inference path, not only that the UI said so.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  acceptConfirm,
  chat,
  type Gateway,
  goTo,
  type PageWatch,
  signedIn,
  startGateway,
  toast,
} from "./support/gateway";

test.describe.configure({ mode: "serial" });

let gw: Gateway;
let adminKey: string;
let clientKey = "";

test.beforeAll(async () => {
  gw = await startGateway();
  adminKey = await gw.mintKey("console-admin", ["admin"]);
});
test.afterAll(async () => {
  await gw?.stop();
});

async function headVersion(): Promise<number> {
  const r = await gw.admin<{ head: number }>("GET", "/config/versions?limit=1");
  return r.body.head;
}

async function content(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const j = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return j.choices[0]!.message.content;
}

/** Wizard: preset → name/baseURL → keys → create → test → fetch models → publish the given models. */
async function addChannel(page: Page, label: string, publish: string[]): Promise<void> {
  await goTo(page, "渠道");
  await page.getByRole("button", { name: "添加渠道" }).click();
  const modal = page.getByRole("dialog", { name: "添加渠道" });
  await modal.locator("label.field", { hasText: "预设" }).locator("select").selectOption("openai");
  await modal.locator("label.field", { hasText: "名称" }).locator("input").fill(label);
  await modal
    .locator("label.field", { hasText: "Base URL" })
    .locator("input")
    .fill(`https://${label}.upstream.test/v1`);
  await modal.getByRole("button", { name: "下一步" }).click();
  await modal.locator("label.field", { hasText: "上游 key" }).locator("textarea").fill(`sk-${label}-0123456789abcdef`);
  const before = await headVersion();
  await modal.getByRole("button", { name: "创建" }).click();
  await toast(page, `已生效 · 版本 #${before + 1}`);
  await modal.getByRole("button", { name: "测试连通性" }).click();
  await expect(modal.getByText(/连通 · \d+ ms/)).toBeVisible();
  await modal.getByRole("button", { name: "下一步" }).click();
  await modal.getByRole("button", { name: "拉取模型列表" }).click();
  for (const m of publish) await modal.locator(".pick-row", { hasText: m }).locator('input[type="checkbox"]').check();
  await modal.getByRole("button", { name: "发布所选模型" }).click();
  await toast(page, "渠道已创建");
  await expect(modal).toHaveCount(0);
  await expect(page.locator("table.card tbody tr", { hasText: label })).toBeVisible();
}

let watch: PageWatch;

test("validation errors from the server are shown on their fields (wizard name and SSRF-refused base URL)", async ({
  browser,
}) => {
  const s = await signedIn(browser, gw, adminKey);
  watch = s.watch;
  const page = s.page;
  await goTo(page, "渠道");
  await page.getByRole("button", { name: "添加渠道" }).click();
  const modal = page.getByRole("dialog", { name: "添加渠道" });
  const nameField = modal.locator("label.field", { hasText: "名称" });
  const urlField = modal.locator("label.field", { hasText: "Base URL" });
  await modal.locator("label.field", { hasText: "预设" }).locator("select").selectOption("openai");
  await nameField.locator("input").fill("bad name!");
  await urlField.locator("input").fill("https://alpha.upstream.test/v1");
  await modal.getByRole("button", { name: "下一步" }).click();
  await modal.getByRole("button", { name: "创建" }).click();
  // Back on step 1 with the message on the name field.
  await expect(nameField.locator(".field-error")).toContainText("no spaces");
  await expect(nameField).toHaveClass(/invalid/);

  await nameField.locator("input").fill("internal");
  await urlField.locator("input").fill("http://10.1.2.3/v1");
  await modal.getByRole("button", { name: "下一步" }).click();
  await modal.getByRole("button", { name: "创建" }).click();
  await expect(urlField.locator(".field-error")).toContainText("private address");
  await page.keyboard.press("Escape");
  expect((await gw.admin<{ data: unknown[] }>("GET", "/channels")).body.data).toHaveLength(1); // only the seed
  await watch.assertClean();
  await s.context.close();
});

test("channel wizard: preset → key → test → fetch models → publish; the model is served", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await addChannel(page, "alpha", ["fake-chat", "fake-slow"]);
  await goTo(page, "模型");
  await expect(page.locator("table.card").first()).toContainText("fake-chat");
  // Live on /v1 for a key minted now.
  const key = await gw.mintKey("probe", ["inference"]);
  expect(await content(await chat(gw, key, "fake-chat"))).toBe("alpha:fake-chat");
  // An unpublished upstream model is not served.
  expect((await chat(gw, key, "fake-extra")).status).toBe(404);
  await watch.assertClean();
  await context.close();
});

test("explicit models + second channel: model drawer edit, reorder bindings by buttons and by drag → live", async ({
  browser,
}) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "设置");
  await page.getByRole("button", { name: "切换为显式模型" }).click();
  await toast(page, /已生效 · 版本 #\d+/);
  expect((await gw.admin<{ modelSource: string }>("GET", "/models")).body.modelSource).toBe("explicit");

  // Wizard in explicit mode adds a binding on the existing public model.
  await addChannel(page, "beta", ["fake-chat"]);
  const key = await gw.mintKey("probe2", ["inference"]);
  expect(await content(await chat(gw, key, "fake-chat"))).toBe("alpha:fake-chat");

  await goTo(page, "模型");
  await page.locator("table.card tbody tr", { hasText: "fake-chat" }).getByRole("button", { name: "编辑" }).click();
  const drawer = page.getByRole("dialog", { name: "fake-chat" });
  const rows = drawer.locator("table.bindings tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("select")).toHaveValue(/^ch_/);
  const firstChannel = await rows.nth(0).locator("select option:checked").textContent();
  expect(firstChannel).toBe("alpha");
  await drawer.locator("label.field", { hasText: "显示名" }).locator("input").fill("Fake Chat");
  await rows.nth(1).getByRole("button", { name: "up" }).click();
  await expect(rows.nth(0).locator("select option:checked")).toHaveText("beta");
  const before = await headVersion();
  await drawer.getByRole("button", { name: "保存" }).click();
  // Two writes (metadata PATCH, bindings PUT); the toast names the version that is live now.
  await toast(page, `已生效 · 版本 #${before + 2}`);
  expect(await headVersion()).toBe(before + 2);
  expect(await content(await chat(gw, key, "fake-chat"))).toBe("beta:fake-chat");
  const model = await gw.admin<{ data: Array<{ name: string; displayName: string }> }>("GET", "/models");
  expect(model.body.data.find((m) => m.name === "fake-chat")?.displayName).toBe("Fake Chat");

  // Drag alpha back to the top (HTML5 drag and drop on the row).
  await page.locator("table.card tbody tr", { hasText: "fake-chat" }).getByRole("button", { name: "编辑" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("select option:checked")).toHaveText("beta");
  await rows.nth(1).locator("td.handle").dragTo(rows.nth(0).locator("td.handle"));
  await expect(rows.nth(0).locator("select option:checked")).toHaveText("alpha");
  await drawer.getByRole("button", { name: "保存" }).click();
  await toast(page, `已生效 · 版本 #${before + 4}`);
  expect(await content(await chat(gw, key, "fake-chat"))).toBe("alpha:fake-chat");
  await watch.assertClean();
  await context.close();
});

test("409: the same model edited in two pages → the stale save says 已被修改，请刷新", async ({ browser }) => {
  const a = await signedIn(browser, gw, adminKey);
  const b = await signedIn(browser, gw, adminKey);
  for (const s of [a, b]) {
    await goTo(s.page, "模型");
    await s.page.locator("table.card tbody tr", { hasText: "fake-chat" }).getByRole("button", { name: "编辑" }).click();
    await expect(s.page.getByRole("dialog", { name: "fake-chat" }).locator("table.bindings tbody tr")).toHaveCount(2);
  }
  const da = a.page.getByRole("dialog", { name: "fake-chat" });
  const db = b.page.getByRole("dialog", { name: "fake-chat" });
  await db.locator("label.field", { hasText: "描述" }).locator("input").fill("edited in B");
  await db.getByRole("button", { name: "保存" }).click();
  await toast(b.page, /已生效 · 版本 #\d+/);
  await da.locator("label.field", { hasText: "描述" }).locator("input").fill("edited in A");
  await da.getByRole("button", { name: "保存" }).click();
  await toast(a.page, "已被修改，请刷新");
  const m = await gw.admin<{ data: Array<{ name: string; description: string }> }>("GET", "/models");
  expect(m.body.data.find((x) => x.name === "fake-chat")?.description).toBe("edited in B");
  await a.watch.assertClean();
  await b.watch.assertClean();
  await a.context.close();
  await b.context.close();
});

test("keys: create → plaintext once → call /v1 → usage shown → quota exhausted → raise → reset → revoke", async ({
  browser,
}) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "密钥");
  await page.getByRole("button", { name: "创建密钥" }).click();
  const form = page.getByRole("dialog", { name: "创建密钥" });
  await form.locator("label.field", { hasText: "名称" }).locator("input").fill("app-1");
  await form.locator("label.check", { hasText: "fake-chat" }).locator("input").check();
  await form.locator("label.field", { hasText: "token 额度" }).locator("input").fill("100");
  await form.getByRole("button", { name: "创建" }).click();
  const shown = page.locator(".modal p.secret code");
  await expect(shown).toBeVisible();
  clientKey = (await shown.textContent()) ?? "";
  expect(clientKey.length).toBeGreaterThan(20);
  await page.locator(".modal").getByRole("button", { name: "关闭" }).last().click();
  await expect(page.locator(".modal")).toHaveCount(0);
  // Shown once: the list never carries it again.
  await expect(page.locator("main")).not.toContainText(clientKey);

  // Use it over HTTP: allowed model OK, other model 403 / not allowed.
  expect(await content(await chat(gw, clientKey, "fake-chat"))).toBe("alpha:fake-chat");
  expect((await chat(gw, clientKey, "fake-slow")).status).toBe(403);
  const row = page.locator("table.card tbody tr", { hasText: "app-1" });
  await expect(async () => {
    await page.getByRole("button", { name: "刷新" }).click();
    await expect(row).toContainText("33", { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(row).toContainText("剩余 67");

  // 33 + 33 + 33 = 99 < 100 → the 4th request is admitted (and finishes); then 403 quota_exhausted.
  for (let i = 0; i < 3; i++) expect((await chat(gw, clientKey, "fake-chat")).status).toBe(200);
  const over = await chat(gw, clientKey, "fake-chat");
  expect(over.status).toBe(403);
  const err = ((await over.json()) as { error: { code: string; type: string } }).error;
  expect(err).toMatchObject({ type: "insufficient_quota", code: "quota_exhausted" });
  await expect(async () => {
    await page.getByRole("button", { name: "刷新" }).click();
    await expect(row).toContainText("额度已用完", { timeout: 1000 });
  }).toPass({ timeout: 10_000 });

  // Raise the quota in the edit drawer.
  await row.getByRole("button", { name: "编辑" }).click();
  const drawer = page.getByRole("dialog", { name: "app-1" });
  await drawer.locator("label.field", { hasText: "token 额度" }).locator("input").fill("1000");
  await drawer.getByRole("button", { name: "保存" }).click();
  await toast(page, "已保存");
  await expect(row).not.toContainText("额度已用完");
  expect((await chat(gw, clientKey, "fake-chat")).status).toBe(200);

  // Reset usage.
  acceptConfirm(page);
  await row.getByRole("button", { name: "用量清零" }).click();
  await toast(page, "已保存");
  await expect(row).toContainText("剩余 1,000");

  // Revoke a throwaway key; it stops working at once.
  const throwaway = await gw.mintKey("throwaway", ["inference"]);
  await page.getByRole("button", { name: "刷新" }).click();
  const trow = page.locator("table.card tbody tr", { hasText: "throwaway" });
  acceptConfirm(page);
  await trow.getByRole("button", { name: "吊销" }).click();
  await expect(trow).toContainText("已吊销");
  expect((await chat(gw, throwaway, "fake-chat")).status).toBe(401);
  await watch.assertClean();
  await context.close();
});

test("usage page renders charts and totals; logs page lists the requests", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "用量");
  await expect(page.locator(".chart svg polyline").first()).toBeVisible();
  await expect(page.locator(".barlist .bar-row").first()).toBeVisible();
  await expect(page.locator("main")).toContainText("app-1");
  await page.locator("label.field", { hasText: "分组" }).locator("select").selectOption({ label: "按模型" });
  await expect(page.locator(".barlist")).toContainText("fake-chat");
  await page.locator("label.field", { hasText: "分组" }).locator("select").selectOption({ label: "按渠道" });
  await expect(page.locator(".barlist")).toContainText("alpha");

  await goTo(page, "日志");
  await expect(page.locator("main table tbody tr").first()).toBeVisible();
  await expect(page.locator("main table")).toContainText("fake-chat");
  await watch.assertClean();
  await context.close();
});

test("playground: non-stream answer, streaming answer, and stop mid-stream", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "Playground");
  const model = page.locator("label.field", { hasText: "模型" }).locator("select");
  const composer = page.locator("form.composer textarea");
  const last = page.locator(".msg.assistant .bubble").last();

  await model.selectOption("fake-chat");
  await page.locator("label.check", { hasText: "流式" }).locator("input").uncheck();
  await composer.fill("hello");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(last).toHaveText("alpha:fake-chat");
  await expect(page.locator(".msg.assistant .muted").last()).toContainText("33 tokens");

  await page.locator("label.check", { hasText: "流式" }).locator("input").check();
  await composer.fill("again");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(last).toHaveText("alpha:fake-chat");

  await model.selectOption("fake-slow");
  await composer.fill("long one");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(last).toContainText("tick2");
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
  const atStop = (await last.textContent()) ?? "";
  await page.waitForTimeout(800);
  expect(await last.textContent()).toBe(atStop);
  expect(atStop).not.toContain("tick39");
  await expect(page.locator("main .error-box")).toHaveCount(0);
  await watch.assertClean();
  await context.close();
});

test("a config change saved in the console never cuts a stream that is already running", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  const key = await gw.mintKey("streamer", ["inference"]);
  const res = await chat(gw, key, "fake-slow", { stream: true });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes("tick1 ")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  // Mid-stream: edit the very model being streamed (a new config version goes live).
  await goTo(page, "模型");
  await page.locator("table.card tbody tr", { hasText: "fake-slow" }).getByRole("button", { name: "编辑" }).click();
  const drawer = page.getByRole("dialog", { name: "fake-slow" });
  await drawer.locator("label.field", { hasText: "描述" }).locator("input").fill("changed mid-stream");
  await drawer.getByRole("button", { name: "保存" }).click();
  await toast(page, /已生效 · 版本 #\d+/);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  expect(text).toContain("tick39 ");
  expect(text).toContain('"finish_reason":"stop"');
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  await watch.assertClean();
  await context.close();
});

test("versions: diff with previous, rollback → live; audit list shows the writes", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  const key = await gw.mintKey("probe3", ["inference"]);
  await goTo(page, "版本与审计");
  const head = await headVersion();
  const versions = page.locator("section.card", { hasText: "配置版本" });
  const headRow = versions.locator("tbody tr", { hasText: "HEAD" });
  await expect(headRow).toContainText(`#${head}`);
  await headRow.getByRole("button", { name: "与上一版对比" }).click();
  const diff = page.getByRole("dialog", { name: `#${head - 1} → #${head}` });
  await expect(diff.locator(".diff > div").first()).toBeVisible();
  await page.keyboard.press("Escape");

  // Find the version before beta's binding moved to the top (description "edited in B" came later):
  // roll back to the version right after the wizard created beta → fake-chat served by alpha, no display name.
  const list = await gw.admin<{ data: Array<{ version: number; summary: string }> }>(
    "GET",
    "/config/versions?limit=50",
  );
  const target = list.body.data.filter((v) => /channel/i.test(v.summary) && /beta/i.test(v.summary)).at(-1);
  expect(target, JSON.stringify(list.body.data)).toBeTruthy();
  const row = versions
    .locator("tbody tr")
    .filter({ has: page.locator("td").first().getByText(`#${target!.version}`, { exact: true }) });
  acceptConfirm(page);
  await row.getByRole("button", { name: "回滚到此版本" }).click();
  await toast(page, `已生效 · 版本 #${head + 1}`);
  expect(await headVersion()).toBe(head + 1);
  const models = await gw.admin<{ data: Array<{ name: string; displayName: string | null }> }>("GET", "/models");
  expect(models.body.data.find((m) => m.name === "fake-chat")?.displayName ?? null).toBeNull();
  expect(await content(await chat(gw, key, "fake-chat"))).toBe("alpha:fake-chat");

  const audit = page.locator("section.card", { hasText: "审计日志" });
  await expect(audit.locator("tbody tr").first()).toBeVisible();
  await expect(audit).toContainText("rollback");
  await expect(audit).toContainText("session");
  await watch.assertClean();
  await context.close();
});

test("sessions: list shows both, revoking the other one signs that browser out", async ({ browser }) => {
  const a = await signedIn(browser, gw, adminKey);
  const b = await signedIn(browser, gw, adminKey, "en");
  await goTo(a.page, "设置");
  const table = a.page.locator("section.card", { hasText: "控制台会话" }).locator("tbody tr");
  await expect(table.filter({ hasText: "当前" })).toHaveCount(1);
  const others = table.filter({ hasNotText: "当前" });
  expect(await others.count()).toBeGreaterThanOrEqual(1);
  // Revoke every other session (b's among them).
  while ((await others.count()) > 0) {
    const n = await others.count();
    await others.first().getByRole("button", { name: "吊销" }).click();
    await expect(others).toHaveCount(n - 1);
  }
  await b.page.locator("header.top nav").getByRole("link", { name: "Keys" }).click();
  await expect(b.page.getByRole("heading", { name: "Sign in to the console" })).toBeVisible();
  await expect(b.page.locator(".toasts .toast.error")).toHaveText("Session expired; sign in again");
  // a is still signed in.
  await goTo(a.page, "密钥");
  await a.watch.assertClean();
  await b.watch.assertClean();
  await a.context.close();
  await b.context.close();
});
