/**
 * Console regressions from the 2026-11-02 review, in a real browser against
 * the real server:
 *  - U2: editing a key restricted to NO models (allowedModels: []) and saving
 *    an unrelated field used to widen it to ALL models;
 *  - U5: the model drawer saved with PATCH model then PUT bindings, so a
 *    bindings error left the field change live and the retry answered 409.
 */
import { expect, test } from "@playwright/test";
import { type Gateway, goTo, signedIn, startGateway, toast } from "./support/gateway";

test.describe.configure({ mode: "serial" });

let gw: Gateway;
let adminKey: string;

test.beforeAll(async () => {
  gw = await startGateway();
  adminKey = await gw.mintKey("console-admin", ["admin"]);
  // Explicit models, so the model drawer is editable.
  const s = await gw.admin<{ revision: number }>("GET", "/settings");
  const r = await gw.admin("PATCH", "/settings", { modelSource: "explicit" }, { "If-Match": `"${s.body.revision}"` });
  expect(r.status).toBe(200);
});
test.afterAll(async () => {
  await gw?.stop();
});

type KeyList = { keys: Array<{ name: string; allowedModels: string[] | null }> };
const allowedOf = async (name: string) =>
  (await gw.admin<KeyList>("GET", "/keys")).body.keys.find((k) => k.name === name)?.allowedModels;

test("U2 keys: a key allowed NO models stays so when another field is saved; 全部模型 vs none is explicit", async ({
  browser,
}) => {
  await gw.mintKey("restricted-none", ["inference"], { allowedModels: [] });
  expect(await allowedOf("restricted-none")).toEqual([]);
  const { page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "密钥");
  const row = page.locator("table.card tbody tr", { hasText: "restricted-none" });
  await expect(row).toContainText("不能调用任何模型");
  await row.getByRole("button", { name: "编辑" }).click();
  const drawer = page.getByRole("dialog", { name: "restricted-none" });
  const group = drawer.getByRole("group", { name: "可用模型" });
  await expect(group.getByRole("radio", { name: "仅限勾选的模型" })).toBeChecked();
  await expect(group).toContainText("没有勾选任何模型");
  await drawer.locator("label.field", { hasText: "token 额度" }).locator("input").fill("1000"); // unrelated edit
  await drawer.getByRole("button", { name: "保存" }).click();
  await toast(page, "已保存");
  expect(await allowedOf("restricted-none")).toEqual([]);

  // Choosing 全部模型 explicitly is the only way to widen it.
  await row.getByRole("button", { name: "编辑" }).click();
  await drawer.getByRole("group", { name: "可用模型" }).getByRole("radio", { name: "全部模型" }).check();
  await drawer.getByRole("button", { name: "保存" }).click();
  await toast(page, "已保存");
  expect(await allowedOf("restricted-none")).toBeNull();
  await expect(row).toContainText("全部模型");
  await watch.assertClean();
  await page.context().close();
});

test("U5 models: a bindings error saves nothing; fixing it and saving again works (no 409)", async ({ browser }) => {
  const m = await gw.admin<{ id: string }>("POST", "/models", {
    name: "m-atomic",
    bindings: [{ channel: "seed", upstreamModel: "seed-chat" }],
  });
  expect(m.status).toBe(201);
  const v0 = (await gw.admin<{ head: number }>("GET", "/config/versions?limit=1")).body.head;
  const { page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "模型");
  await page.locator("table.card tbody tr", { hasText: "m-atomic" }).getByRole("button", { name: "编辑" }).click();
  const drawer = page.getByRole("dialog", { name: "m-atomic" });
  await drawer.locator("label.field", { hasText: "描述" }).locator("input").fill("all or nothing");
  // A binding the server rejects: upstream model name longer than 200 characters.
  const upstream = drawer.locator("table.bindings tbody tr").first().locator("td").nth(3).locator("input");
  await upstream.fill("x".repeat(201));
  await drawer.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".toasts .toast.error").first()).toBeVisible();
  const after = await gw.admin<{ description: string | null }>("GET", `/models/${m.body.id}`);
  expect(after.body.description ?? null).toBeNull(); // nothing went live
  expect((await gw.admin<{ head: number }>("GET", "/config/versions?limit=1")).body.head).toBe(v0);

  // Fix the binding and save again from the same drawer: one write, live.
  await upstream.fill("seed-chat");
  await drawer.getByRole("button", { name: "保存" }).click();
  await toast(page, /已生效/);
  const saved = await gw.admin<{ description: string | null }>("GET", `/models/${m.body.id}`);
  expect(saved.body.description).toBe("all or nothing");
  expect((await gw.admin<{ head: number }>("GET", "/config/versions?limit=1")).body.head).toBe(v0 + 1);
  await watch.assertClean();
  await page.context().close();
});
