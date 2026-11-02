/** @jsxImportSource preact */
// Console component tests (0.3.0 P6): sign-in, key creation (plaintext once), field errors,
// 409 handling, i18n, and the pure helpers behind channels / models / versions.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { render } from "preact";
import { byText, type Dom, installDom, settle, type } from "./_dom";

let dom: Dom;
let root: HTMLElement;
// Imported after the DOM exists (modules read localStorage / navigator at load).
let mod: {
  app: typeof import("../../console/src/app");
  i18n: typeof import("../../console/src/i18n");
  keys: typeof import("../../console/src/pages/keys");
  models: typeof import("../../console/src/pages/models");
  channels: typeof import("../../console/src/pages/channels");
  versions: typeof import("../../console/src/pages/versions");
  settings: typeof import("../../console/src/pages/settings");
  api: typeof import("../../console/src/api");
};

beforeAll(async () => {
  dom = installDom();
  mod = {
    app: await import("../../console/src/app"),
    i18n: await import("../../console/src/i18n"),
    keys: await import("../../console/src/pages/keys"),
    models: await import("../../console/src/pages/models"),
    channels: await import("../../console/src/pages/channels"),
    versions: await import("../../console/src/pages/versions"),
    settings: await import("../../console/src/pages/settings"),
    api: await import("../../console/src/api"),
  };
  mod.i18n.setLang("zh");
});
afterAll(() => dom.restore());
afterEach(() => {
  if (root) render(null, root);
  dom.calls.length = 0;
  dom.routes.clear();
});

function mount(node: preact.ComponentChild): HTMLElement {
  root = document.createElement("div");
  document.body.appendChild(root);
  render(node, root);
  return root;
}

describe("sign-in", () => {
  it("posts the key once, stores nothing in the browser, and opens the app", async () => {
    dom.routes.set("GET /admin/session", () =>
      Response.json({ error: { code: "missing_authorization" } }, { status: 401 }),
    );
    dom.routes.set("POST /admin/session/login", () =>
      Response.json({ actor: "key:k1", scopes: ["admin"], csrfToken: "csrf-1", sessionId: "ses_1" }),
    );
    dom.routes.set("GET /admin/status", () =>
      Response.json({ version: "0.3.0", upstreamAvailable: true, circuitBreakers: {} }),
    );
    dom.routes.set("GET /admin/channels", () => Response.json({ data: [] }));
    dom.routes.set("GET /admin/usage", () =>
      Response.json({ data: [], totals: { requests: 0, errors: 0, totalTokens: 0 } }),
    );
    const el = mount(<mod.app.App />);
    await settle();
    const input = el.querySelector<HTMLInputElement>("input[type=password]")!;
    expect(input).toBeTruthy();
    type(input, "sk-admin-secret-value");
    await settle();
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    const loginCall = dom.calls.find((c) => c.path === "/admin/session/login")!;
    expect(loginCall.body).toEqual({ key: "sk-admin-secret-value" });
    expect(el.textContent).toContain("渠道");
    expect(el.textContent).toContain("key:k1");
    // The key is not kept anywhere in the browser.
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie;
    expect(stored).not.toContain("sk-admin-secret-value");
    // Later calls carry no Authorization header, only the CSRF token on writes.
    for (const c of dom.calls) expect(c.headers["authorization"]).toBeUndefined();
  });

  it("shows the lockout message on 429", async () => {
    dom.routes.set("GET /admin/session", () => Response.json({}, { status: 401 }));
    dom.routes.set("POST /admin/session/login", () =>
      Response.json(
        { error: { code: "login_locked", message: "x" } },
        { status: 429, headers: { "Retry-After": "120" } },
      ),
    );
    const el = mount(<mod.app.App />);
    await settle();
    type(el.querySelector<HTMLInputElement>("input[type=password]")!, "sk-x");
    await settle();
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    expect(el.textContent).toContain("120 秒");
  });
});

describe("keys page", () => {
  it("create: sends the limits, shows the plaintext once, with copy", async () => {
    mod.api.setCsrfToken("csrf-xyz");
    dom.routes.set("GET /admin/keys", () => Response.json({ keys: [], total: 0 }));
    dom.routes.set("GET /admin/models", () =>
      Response.json({ modelSource: "explicit", data: [], published: [{ name: "ds-chat" }] }),
    );
    dom.routes.set("POST /admin/keys", () => Response.json({ id: "k9", key: "sk-new-plaintext-key" }, { status: 201 }));
    const el = mount(<mod.keys.KeysPage session={{ via: "session", actor: "a", scopes: ["admin"] }} canWrite />);
    await settle();
    byText(el, "button", "创建密钥")!.click();
    await settle();
    const modal = el.querySelector(".modal")!;
    const inputs = modal.querySelectorAll<HTMLInputElement>("input");
    type(inputs[0]!, "friend");
    await settle();
    (modal.querySelector("input[type=checkbox]") as HTMLInputElement).click();
    await settle();
    const numbers = modal.querySelectorAll<HTMLInputElement>("input[type=number]");
    type(numbers[0]!, "1000000"); // quota
    type(numbers[1]!, "20"); // rpm
    await settle();
    modal.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    const call = dom.calls.find((c) => c.method === "POST" && c.path === "/admin/keys")!;
    expect(call.body).toEqual({
      name: "friend",
      allowedModels: ["ds-chat"],
      quotaTokens: 1000000,
      rpm: 20,
      scopes: ["inference"],
    });
    expect(call.headers["x-csrf-token"]).toBe("csrf-xyz");
    expect(el.textContent).toContain("sk-new-plaintext-key");
    expect(el.textContent).toContain("只显示这一次");
    expect(byText(el, "button", "复制")).toBeTruthy();
    byText(el, ".modal button", "关闭")!.click();
    await settle();
    expect(el.textContent).not.toContain("sk-new-plaintext-key");
  });

  it("a 400 with fields is shown next to the field; a 409 says 已被修改，请刷新", async () => {
    const key = {
      id: "k1",
      name: "friend",
      scopes: ["inference"],
      allowedModels: null,
      expiresAt: null,
      quotaTokens: 10,
      rpm: null,
      tpm: null,
      usedTokens: 0,
      remainingTokens: 10,
      quotaExhausted: false,
      usageResetAt: null,
      revision: 3,
      revokedAt: null,
    };
    dom.routes.set("GET /admin/models", () => Response.json({ published: [] }));
    let reply = () =>
      Response.json(
        {
          error: { code: "invalid_request", message: "rpm: too small", fields: [{ path: "rpm", message: "最小为 1" }] },
        },
        { status: 400 },
      );
    dom.routes.set("PATCH /admin/keys/k1", () => reply());
    const el = mount(<mod.keys.KeyForm existing={key} onClose={() => {}} />);
    await settle();
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    const patch = dom.calls.find((c) => c.method === "PATCH")!;
    expect(patch.headers["if-match"]).toBe('"3"');
    expect(el.querySelector(".field.invalid .field-error")?.textContent).toBe("最小为 1");

    reply = () =>
      Response.json({ error: { code: "revision_mismatch", message: "stale", currentRevision: 4 } }, { status: 409 });
    let closed = false;
    render(null, root);
    const toasts = mount(
      <>
        <mod.keys.KeyForm existing={key} onClose={() => (closed = true)} />
        <ToastsHost />
      </>,
    );
    await settle();
    toasts.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    expect(toasts.textContent).toContain("已被修改，请刷新");
    expect(closed).toBe(true);
  });
});

describe("review 2026-11-02 U2 / U5", () => {
  const baseKey = {
    id: "k9",
    name: "none",
    scopes: ["inference"],
    expiresAt: null,
    quotaTokens: null,
    rpm: null,
    tpm: null,
    usedTokens: 0,
    remainingTokens: null,
    quotaExhausted: false,
    usageResetAt: null,
    revision: 2,
    revokedAt: null,
  };

  it("U2: a key allowed NO models keeps [] when another field is saved; 全部模型 sends null", async () => {
    dom.routes.set("GET /admin/models", () => Response.json({ published: [{ name: "ds-chat" }] }));
    dom.routes.set("PATCH /admin/keys/k9", () => Response.json({ ...baseKey, allowedModels: [] }));
    const el = mount(<mod.keys.KeyForm existing={{ ...baseKey, allowedModels: [] }} onClose={() => {}} />);
    await settle();
    expect(el.textContent).toContain("不能调用任何模型");
    const radios = el.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect(radios[1]!.checked).toBe(true); // 仅限勾选的模型
    type(el.querySelectorAll<HTMLInputElement>("input[type=number]")[0]!, "1000");
    await settle();
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    expect(dom.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ allowedModels: [], quotaTokens: 1000 });

    dom.calls.length = 0;
    radios[0]!.click(); // 全部模型
    await settle();
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    expect(dom.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ allowedModels: null });
  });

  it("U2: a key allowed every model keeps null", async () => {
    dom.routes.set("GET /admin/models", () => Response.json({ published: [{ name: "ds-chat" }] }));
    dom.routes.set("PATCH /admin/keys/k9", () => Response.json({ ...baseKey, allowedModels: null }));
    const el = mount(<mod.keys.KeyForm existing={{ ...baseKey, allowedModels: null }} onClose={() => {}} />);
    await settle();
    expect(el.textContent).not.toContain("不能调用任何模型");
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    expect(dom.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ allowedModels: null });
  });

  it("U5: the model drawer saves fields and bindings in ONE request (PATCH with bindings, no PUT)", async () => {
    const model = {
      id: "mdl1",
      name: "m1",
      enabled: true,
      strategy: "fallback",
      balance: "weighted",
      metadata: {},
      bindings: [{ channelId: "ch1", upstreamModel: "up-1", priority: 0, weight: 1, enabled: true }],
      revision: 5,
    };
    dom.routes.set("GET /admin/models/mdl1", () => Response.json(model));
    dom.routes.set("PATCH /admin/models/mdl1", () => Response.json({ ...model, revision: 6, configVersion: 9 }));
    let closed = false;
    const el = mount(
      <mod.models.ModelDrawer
        id="mdl1"
        canWrite
        channels={[{ id: "ch1", name: "c1", models: ["up-1"] } as never]}
        onClose={() => (closed = true)}
      />,
    );
    await settle(40);
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    const writes = dom.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /admin/models/mdl1"]);
    expect(writes[0]!.headers["if-match"]).toBe('"5"');
    expect(writes[0]!.body).toMatchObject({
      name: "m1",
      bindings: [{ channelId: "ch1", upstreamModel: "up-1", priority: 0, weight: 1, enabled: true }],
    });
    expect(closed).toBe(true);
  });
});

function ToastsHost() {
  const { Toasts } = require("../../console/src/ui") as typeof import("../../console/src/ui");
  return <Toasts />;
}

describe("save feedback", () => {
  it("a config write shows 已生效 · 版本 #N", async () => {
    const ui = await import("../../console/src/ui");
    const el = mount(<ui.Toasts />);
    await settle();
    ui.savedToast({ configVersion: 42 });
    await settle();
    expect(el.textContent).toContain("已生效 · 版本 #42");
  });
});

describe("i18n", () => {
  it("every string has Chinese and English; the switch persists in localStorage", () => {
    for (const [k, [zh, en]] of Object.entries(mod.i18n.DICTIONARY)) {
      expect(zh.length, k).toBeGreaterThan(0);
      expect(en.length, k).toBeGreaterThan(0);
    }
    mod.i18n.setLang("en");
    expect(mod.i18n.t("nav.channels")).toBe("Channels");
    expect(localStorage.getItem("aigw.lang")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    mod.i18n.setLang("zh");
    expect(mod.i18n.t("savedVersion", { v: 7 })).toBe("已生效 · 版本 #7");
  });
});

describe("helpers", () => {
  it("key states: ok / cooling / disabled", () => {
    const base = {
      id: "k",
      kind: "encrypted",
      hint: "sk-…1",
      enabled: true,
      status: "ok",
      weight: 1,
      lastError: null,
      lastErrorAt: null,
    };
    const now = Date.parse("2026-11-02T00:00:00Z");
    expect(mod.channels.keyState(base, now)).toBe("ok");
    expect(mod.channels.keyState({ ...base, cooldownUntil: "2026-11-02T00:01:00Z" }, now)).toBe("cooling");
    expect(mod.channels.keyState({ ...base, cooldownUntil: "2026-11-01T00:00:00Z" }, now)).toBe("ok");
    expect(mod.channels.keyState({ ...base, enabled: false }, now)).toBe("disabled");
    expect(mod.channels.keyState({ ...base, status: "invalid" }, now)).toBe("disabled");
    expect(mod.channels.keyState({ ...base, status: "quota" }, now)).toBe("disabled");
  });

  it("binding rows: drag order → priority groups; round trip", () => {
    const rows = mod.models.bindingsToRows([
      { channelId: "b", upstreamModel: "m", priority: 1, weight: 1 },
      { channelId: "a", upstreamModel: "m", priority: 0, weight: 2 },
      { channelId: "c", upstreamModel: "m", priority: 1, weight: 3 },
    ]);
    expect(rows.map((r) => [r.channelId, r.sameAsPrev])).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ]);
    expect(mod.models.rowsToBindings(rows).map((b) => [b.channelId, b.priority, b.weight])).toEqual([
      ["a", 0, 2],
      ["b", 1, 1],
      ["c", 1, 3],
    ]);
    // Drag c to the top: it starts group 0; a, b follow; b keeps sharing… only with what is above it now.
    const moved = mod.models.moveRow(rows, 2, 0);
    expect(mod.models.rowsToBindings(moved).map((b) => [b.channelId, b.priority])).toEqual([
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("version diff: changed / added / removed, timestamps ignored", () => {
    const a = { channels: [{ name: "x", base_url: "https://a", updated_at: "1" }], aliases: { f: "m1" } };
    const b = {
      channels: [
        { name: "x", base_url: "https://b", updated_at: "2" },
        { name: "y", base_url: "https://y" },
      ],
      aliases: {},
    };
    const d = mod.versions.diffSnapshots(a, b);
    expect(d.find((x) => x.path === "channels[x].base_url")).toMatchObject({
      kind: "changed",
      before: '"https://a"',
      after: '"https://b"',
    });
    expect(d.some((x) => x.kind === "added" && x.path.startsWith("channels[y]"))).toBe(true);
    expect(d.some((x) => x.kind === "removed" && x.path === "aliases.f")).toBe(true);
    expect(d.some((x) => x.path.includes("updated_at"))).toBe(false);
  });

  it("global rate limit edits only the rate-limit plugin", () => {
    const other = { name: "word-filter", stage: "before_request", config: { words: ["x"] } };
    const set = mod.settings.withRateLimit([other], 60, 10000);
    expect(set).toEqual([
      other,
      {
        name: "rate-limit",
        stage: "before_request",
        enabled: true,
        config: { maxRequestsPerMinute: 60, maxTokensPerMinute: 10000 },
      },
    ]);
    expect(mod.settings.withRateLimit(set, null, null)).toEqual([other]);
    const daily = [{ name: "rate_limit", stage: "before_request", config: { rpm: 5, maxRequestsPerDay: 100 } }];
    expect(mod.settings.withRateLimit(daily, null, null)).toEqual([
      { name: "rate_limit", stage: "before_request", config: { maxRequestsPerDay: 100 } },
    ]);
  });
});
