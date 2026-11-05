/**
 * Console fixes from the real-usage UI test (2026-11-05), in a real browser:
 *  - B1 / B2: no page-level horizontal overflow at 390 / 768 / 1366 px, drawers usable at 390 px;
 *  - U2: Chinese mode shows no untranslated known strings (breaker states, HEAD, audit header / actions, summaries);
 *  - U10: rotate a key in the console (confirm, new secret once, old secret dead);
 *  - U11: Playground Enter sends, Shift+Enter is a new line;
 *  - B6: an invalid usage query clears the old charts and says why, in Chinese.
 */
import { expect, type Page, test } from "@playwright/test";
import { acceptConfirm, createChannel, type Gateway, goTo, signedIn, startGateway } from "./support/gateway";

test.describe.configure({ mode: "serial" });

let gw: Gateway;
let adminKey: string;

test.beforeAll(async () => {
  gw = await startGateway();
  adminKey = await gw.mintKey("console-admin", ["admin"]);
  const s = await gw.admin<{ revision: number }>("GET", "/settings");
  await gw.admin("PATCH", "/settings", { modelSource: "explicit" }, { "If-Match": `"${s.body.revision}"` });
  const alpha = await createChannel(gw, "alpha", ["fake-chat", "fake-slow"]);
  const beta = await createChannel(gw, "beta", ["fake-chat"]);
  const r = await gw.admin("POST", "/models", {
    name: "lb-chat",
    strategy: "loadbalance",
    bindings: [
      { channelId: alpha, upstreamModel: "fake-chat", priority: 0, weight: 3 },
      { channelId: beta, upstreamModel: "fake-chat", priority: 1, weight: 1 },
    ],
  });
  expect(r.status).toBe(201);
  for (const name of ["fake-chat", "fake-slow"]) {
    const m = await gw.admin("POST", "/models", { name, bindings: [{ channelId: alpha, upstreamModel: name }] });
    expect(m.status).toBe(201);
  }
  // Some audit / log rows with long details (B1).
  await gw.mintKey("a-key-with-a-rather-long-name-for-the-audit-table-column", ["inference"], {
    allowedModels: ["fake-chat", "lb-chat"],
    quotaTokens: 123456789,
  });
});
test.afterAll(async () => {
  await gw?.stop();
});

const PAGES = ["", "channels", "models", "keys", "usage", "logs", "playground", "settings", "versions"];

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth);
}

test("B1 / B2: no page scrolls sideways at 390, 768 or 1366 px; badges stay on one line", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  for (const width of [390, 768, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    for (const p of PAGES) {
      await page.goto(`/admin/dashboard/${p}`);
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.locator("main .muted", { hasText: "加载中" })).toHaveCount(0);
      expect(await overflow(page), `${p || "overview"} @ ${width}px`).toBeLessThanOrEqual(0);
      const tall = await page.evaluate(
        () => [...document.querySelectorAll(".badge")].filter((b) => b.getBoundingClientRect().height > 26).length,
      );
      expect(tall, `squashed badges on ${p || "overview"} @ ${width}px`).toBe(0);
    }
  }
  await watch.assertClean();
  await context.close();
});

test("B2: drawers and the wizard are full width and usable at 390 px", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/dashboard/models");
  await page.locator("table.card tbody tr", { hasText: "lb-chat" }).getByRole("button", { name: "编辑" }).click();
  const drawer = page.getByRole("dialog", { name: "lb-chat" });
  await expect(drawer.locator("table.bindings tbody tr")).toHaveCount(2);
  const box = await drawer.boundingBox();
  expect(Math.round(box!.width)).toBe(390);
  for (const el of await drawer.locator("table.bindings select, table.bindings td:nth-child(4) input").all()) {
    expect((await el.boundingBox())!.width).toBeGreaterThanOrEqual(120);
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await page.goto("/admin/dashboard/channels");
  await page.getByRole("button", { name: "添加渠道" }).click();
  const modal = page.getByRole("dialog", { name: "添加渠道" });
  expect(Math.round((await modal.boundingBox())!.width)).toBe(390);
  await page.keyboard.press("Escape");
  await watch.assertClean();
  await context.close();
});

test("U2: Chinese mode shows no untranslated known strings", async ({ browser }) => {
  // Make audit / version rows of several kinds first.
  const k = (await gw.admin<{ keys: Array<{ id: string; revision: number }> }>("GET", "/keys")).body.keys[0]!;
  const reset = await gw.admin("POST", `/keys/${k.id}/reset-usage`, undefined, { "If-Match": `"${k.revision}"` });
  expect(reset.status).toBe(200);
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  const banned =
    /\b(closed|half-open|HEAD|detail|Playground|key_create|key_reset_usage|console_login|set_bindings|Create channel|Create model|Update settings|Roll back to)\b/;
  for (const label of ["概览", "渠道", "模型", "密钥", "调试台", "版本与审计"]) {
    await goTo(page, label);
    await expect(page.locator("main .muted", { hasText: "加载中" })).toHaveCount(0);
    // Codes stay available as small tags / titles; the visible label text must be Chinese.
    const text = await page.evaluate(() => {
      const main = document.querySelector("main")!.cloneNode(true) as HTMLElement;
      for (const el of main.querySelectorAll("code, .code-tag, option")) el.remove();
      return main.innerText;
    });
    expect(text, label).not.toMatch(banned);
  }
  await expect(page.locator("main")).toContainText("创建模型“lb-chat”");
  await expect(page.locator("main")).toContainText("用量清零");
  await expect(page.locator("header.top nav")).toContainText("调试台");
  await watch.assertClean();
  await context.close();
});

test("U10: rotate a key in the console: confirm, the new secret once, the old one stops working", async ({
  browser,
}) => {
  const old = await gw.mintKey("rotate-me", ["inference"]);
  const call = async (k: string) =>
    (await gw.fetch("/v1/models", { headers: { authorization: `Bearer ${k}` } })).status;
  expect(await call(old)).toBe(200);
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "密钥");
  acceptConfirm(page);
  await page.locator("table.card tbody tr", { hasText: "rotate-me" }).getByRole("button", { name: "轮换" }).click();
  const modal = page.getByRole("dialog", { name: "新密钥（rotate-me）" });
  const secret = (await modal.locator("p.secret code").innerText()).trim();
  expect(secret).not.toBe(old);
  await expect(modal.getByRole("button", { name: "复制" })).toBeVisible();
  expect(await call(old)).toBe(401);
  expect(await call(secret)).toBe(200);
  await modal.getByRole("button", { name: "关闭" }).last().click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(secret);
  await watch.assertClean();
  await context.close();
});

test("U11: Playground Enter sends, Shift+Enter adds a line; Stop marks the reply", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "调试台");
  await expect(page.locator(".msg-empty")).toBeVisible();
  await page.locator("label.field", { hasText: "模型" }).locator("select").selectOption("fake-chat");
  const composer = page.locator("form.composer textarea");
  await composer.fill("line one");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("line two");
  await expect(composer).toHaveValue("line one\nline two");
  await expect(page.locator(".msg")).toHaveCount(0);
  await composer.press("Enter");
  await expect(page.locator(".msg.user .bubble")).toHaveText("line one\nline two");
  await expect(page.locator(".msg.assistant .bubble").last()).toHaveText("alpha:fake-chat");
  await expect(composer).toHaveValue("");
  // The Send button keeps its two characters on one line.
  const send = page.getByRole("button", { name: "发送" });
  expect((await send.boundingBox())!.height).toBeLessThan(40);

  await page.locator("label.field", { hasText: "模型" }).locator("select").selectOption("fake-slow");
  await composer.fill("slow");
  await composer.press("Enter");
  await expect(page.locator(".msg.assistant .bubble").last()).toContainText("tick1");
  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.locator(".msg.assistant").last().locator(".stopped")).toHaveText("已停止");
  await watch.assertClean();
  await context.close();
});

test("B6: an invalid usage query clears the charts and explains, in Chinese", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "用量");
  await expect(page.locator("main .chart svg").first()).toBeVisible();
  const from = page.locator("label.field", { hasText: "开始" }).locator("input");
  await from.fill("2099-01-01");
  await from.dispatchEvent("change");
  await expect(page.locator("main .error-box")).toHaveText("开始日期不能晚于结束日期");
  await expect(page.locator("main .chart, main table, main .barlist")).toHaveCount(0);
  await page.reload();
  const tz = page.locator("main input[list=tz-list]");
  await tz.fill("Mars/Base");
  await tz.blur();
  await expect(page.locator("main .error-box")).toContainText("不是有效的时区");
  await expect(page.locator("main .chart, main table, main .barlist")).toHaveCount(0);
  await watch.assertClean();
  await context.close();
});

test("U6: a load-balanced model is shown as one weighted set, not a priority chain", async ({ browser }) => {
  const { context, page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "模型");
  const row = page.locator("table.card tbody tr", { hasText: "lb-chat" });
  await expect(row).toContainText("负载均衡");
  await expect(row).toContainText("75%");
  await expect(row).toContainText("25%");
  await expect(row).not.toContainText("→");
  await row.getByRole("button", { name: "编辑" }).click();
  const drawer = page.getByRole("dialog", { name: "lb-chat" });
  await expect(drawer).toContainText("优先级组不起作用");
  await expect(drawer.locator("table.bindings thead")).toContainText("占比");
  await watch.assertClean();
  await context.close();
});
