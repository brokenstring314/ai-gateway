/**
 * RC1 (red team 2026-11-02) in the console: moving a channel's base URL to
 * another origin requires its key(s) again — the drawer shows a notice and a
 * required key field, refuses to save without a key, and saving with one
 * replaces the stored keys. A same-origin path change needs no key.
 */
import { expect, test } from "@playwright/test";
import { createChannel, type Gateway, goTo, signedIn, startGateway, toast } from "./support/gateway";

test.describe.configure({ mode: "serial" });

let gw: Gateway;
let adminKey: string;

test.beforeAll(async () => {
  gw = await startGateway();
  adminKey = await gw.mintKey("console-admin", ["admin"]);
});
test.afterAll(async () => {
  await gw?.stop();
});

type ChannelOut = { baseURL: string | null; keys: Array<{ hint: string }> };

test("RC1 channel drawer: a new origin needs the key(s) again; same origin does not", async ({ browser }) => {
  const id = await createChannel(gw, "gamma", ["fake-chat"]);
  const { page, watch } = await signedIn(browser, gw, adminKey);
  await goTo(page, "渠道");
  const row = page.locator("table.card tbody tr", { hasText: "gamma" });
  await row.getByRole("button", { name: "编辑" }).click();
  const drawer = page.getByRole("dialog", { name: "gamma" });
  const base = drawer.locator("label.field", { hasText: "Base URL" }).locator("input");
  await expect(base).toHaveValue("https://gamma.upstream.test/v1");

  // Same origin, other path: no key field.
  await base.fill("https://gamma.upstream.test/v2");
  await expect(drawer.getByTestId("rekey")).toHaveCount(0);

  // Another origin: notice + required key field; saving without a key is refused in the page.
  await base.fill("https://delta.upstream.test/v1");
  const rekey = drawer.getByTestId("rekey");
  await expect(rekey).toBeVisible();
  await expect(rekey).toContainText("不会发往新地址");
  await drawer.getByRole("button", { name: "保存" }).first().click();
  await expect(rekey.locator(".field-error")).toHaveText("更换到新地址时必须重新输入至少一个 key");
  let ch = (await gw.admin<ChannelOut>("GET", `/channels/${id}`)).body;
  expect(ch.baseURL).toBe("https://gamma.upstream.test/v1");

  // With a key: saved, keys replaced.
  await rekey.locator("textarea").fill("sk-delta-new-upstream-9999zzzz");
  await drawer.getByRole("button", { name: "保存" }).first().click();
  await toast(page, /已生效/);
  ch = (await gw.admin<ChannelOut>("GET", `/channels/${id}`)).body;
  expect(ch.baseURL).toBe("https://delta.upstream.test/v1");
  expect(ch.keys.map((k) => k.hint)).toEqual(["sk-…zzzz"]);
  await expect(drawer.getByTestId("rekey")).toHaveCount(0);

  await watch.assertClean();
  await page.context().close();
});

test("RC1 channel drawer (en): the notice and the error are translated", async ({ browser }) => {
  const id = await createChannel(gw, "epsilon", []);
  const { page, watch } = await signedIn(browser, gw, adminKey, "en");
  await goTo(page, "Channels");
  await page.locator("table.card tbody tr", { hasText: "epsilon" }).getByRole("button", { name: "Edit" }).click();
  const drawer = page.getByRole("dialog", { name: "epsilon" });
  const base = drawer.locator("label.field", { hasText: "Base URL" }).locator("input");
  // Wait for the loaded channel: filling before the drawer's form is populated gets overwritten (CI flake).
  await expect(base).toHaveValue("https://epsilon.upstream.test/v1");
  await base.fill("https://zeta.upstream.test/v1");
  const rekey = drawer.getByTestId("rekey");
  await expect(rekey).toContainText("never sent to a new origin");
  await drawer.getByRole("button", { name: "Save" }).first().click();
  await expect(rekey.locator(".field-error")).toHaveText("Enter at least one key: a new origin needs its key(s) again");
  expect((await gw.admin<ChannelOut>("GET", `/channels/${id}`)).body.baseURL).toBe("https://epsilon.upstream.test/v1");
  await watch.assertClean();
  await page.context().close();
});
