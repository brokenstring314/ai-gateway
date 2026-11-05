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
    // U12: minutes, not "120 秒".
    expect(el.textContent).toContain("请 2 分钟后再试");
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
    // Change one field and one binding: both go out together, and nothing else (UI test U9).
    const display = el.querySelectorAll<HTMLInputElement>(".grid2 input")[1]!;
    type(display, "Model One");
    const weight = el.querySelector<HTMLInputElement>("table.bindings input.narrow")!;
    type(weight, "3");
    await settle();
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle(40);
    const writes = dom.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /admin/models/mdl1"]);
    expect(writes[0]!.headers["if-match"]).toBe('"5"');
    expect(writes[0]!.body).toEqual({
      displayName: "Model One",
      bindings: [{ channelId: "ch1", upstreamModel: "up-1", priority: 0, weight: 3, enabled: true }],
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

describe("UI test 2026-11-05 fixes", () => {
  it("U3: toasts are de-duplicated and capped at 3", async () => {
    const ui = await import("../../console/src/ui");
    ui.clearToasts();
    const el = mount(<ui.Toasts />);
    await settle();
    ui.notify("same", "error");
    ui.notify("same", "error");
    ui.notify("same", "error");
    await settle();
    expect(el.querySelectorAll(".toast").length).toBe(1);
    for (const n of [1, 2, 3, 4, 5]) ui.notify(`t${n}`);
    await settle();
    const texts = [...el.querySelectorAll(".toast")].map((x) => x.textContent);
    expect(texts).toEqual(["t3", "t4", "t5"]);
    (el.querySelector(".toast") as HTMLElement).click();
    await settle();
    expect(el.querySelectorAll(".toast").length).toBe(2);
  });

  it("U3: the wizard checks the Base URL before the key step", () => {
    const p = mod.channels.baseUrlProblem;
    expect(p("")).toBeUndefined();
    expect(p("https://api.deepseek.com/v1")).toBeUndefined();
    expect(p("http://8.8.8.8/v1")).toBeUndefined();
    expect(p("api.example.com")).toBe("ch.urlInvalid");
    expect(p("ftp://api.example.com")).toBe("ch.urlScheme");
    expect(p("https://u:p@api.example.com")).toBe("ch.urlCreds");
    for (const local of ["http://localhost:11434/v1", "http://ollama.local/v1", "http://gpu-box/v1"]) {
      expect(p(local)).toBe("ch.urlLocal");
    }
    for (const priv of ["http://127.0.0.1/v1", "http://10.1.2.3/v1", "http://192.168.1.5/v1", "http://[::1]/v1"]) {
      expect(p(priv)).toBe("ch.urlPrivate");
    }
  });

  it("U2: server errors are shown by code in the console's language, else as sent", () => {
    const { errorMessage, setLang } = mod.i18n;
    setLang("zh");
    expect(
      errorMessage("channel_in_use", 'the channel is bound by model(s) "a", "b"; remove those bindings first'),
    ).toBe("该渠道仍被模型 “a”、“b” 绑定，请先移除这些绑定");
    expect(errorMessage("name_taken", 'a model named "m1" already exists')).toBe("名称“m1”已被占用");
    expect(errorMessage("invalid_request", "from must not be after to")).toBe("开始日期不能晚于结束日期");
    expect(errorMessage("date_range_inverted", "from must not be after to")).toBe("开始日期不能晚于结束日期");
    expect(errorMessage("auth_locked", "x", { retryAfter: 900 })).toBe("失败次数过多，请 15 分钟后再试");
    expect(
      errorMessage(
        "unsafe_base_url",
        "baseURL points to a private address (10.0.0.0/8); only public internet addresses are allowed",
      ),
    ).toBe("Base URL 不被允许：指向非公网地址（private address (10.0.0.0/8)），只允许公网地址");
    expect(errorMessage("brand_new_code", "Something new")).toBe("Something new");
    setLang("en");
    expect(errorMessage("name_taken", 'a model named "m1" already exists')).toBe('The name "m1" is already taken');
    setLang("zh");
  });

  it("U2: no Chinese-mode string is left in English except technical terms", () => {
    const allowed = new Set(["Base URL", "RPM", "TPM", "logprobs", "IP", "key"]);
    for (const table of [mod.i18n.DICTIONARY, ...Object.values(mod.i18n.LABEL_TABLES)]) {
      for (const [k, [zh, en]] of Object.entries(table)) {
        if (allowed.has(zh)) continue;
        expect(zh === en && /[A-Za-z]{3}/.test(zh), `${k}: "${zh}"`).toBe(false);
      }
    }
  });

  it("U9: version summaries and diffs are readable; internal columns hidden, secrets masked", async () => {
    const vf = await import("../../console/src/versions-format");
    expect(vf.summaryText('Update model "fake-slow" (name, displayName)')).toBe("修改模型“fake-slow”（名称、显示名）");
    expect(vf.summaryText("Roll back to config version 16")).toBe("回滚到配置版本 #16");
    expect(vf.summaryText('disable key sk-…6789 on channel "alpha"')).toBe("停用 key sk-…6789（渠道“alpha”）");
    expect(vf.summaryText("Something the console does not know")).toBe("Something the console does not know");
    const snap = (weight: number) => ({
      format: 2,
      channels: [
        {
          id: "ch_1",
          name: "alpha",
          base_url: "https://a.example/v1",
          enabled: 1,
          settings_json: '{"keyStrategy":"weighted"}',
          revision: weight,
          updated_at: String(weight),
        },
      ],
      keys: [{ id: "chk_1", channel_id: "ch_1", hint: "sk-…aaaa", enabled: 1, status: "ok", weight, position: 0 }],
      models: [{ id: "mdl_1", name: "m", enabled: 1, metadata_json: "{}", routing_json: '{"strategy":"fallback"}' }],
      bindings: [
        {
          id: "bnd_1",
          model_id: "mdl_1",
          channel_id: "ch_1",
          upstream_model: "up",
          priority: 0,
          weight,
          enabled: 1,
          overrides_json: "{}",
        },
      ],
      settings: [{ key: "aliases", value_json: '{"x":"m"}' }],
      meta: { models_explicit: "1" },
    });
    const d = vf.readableDiff(snap(1), snap(2));
    expect(d.map((x) => vf.pathText(x.segs))).toEqual([
      "渠道 › alpha › 上游 key › sk-…aaaa › 权重",
      "模型 › m › 绑定 › alpha → up › 权重",
    ]);
    const text = JSON.stringify(
      vf.readableSnapshot({
        ...snap(1),
        channels: [{ ...snap(1).channels[0]!, api_key: "sk-live-abcdefghijkl" }],
      }),
    );
    expect(text).not.toContain("sk-live-abcdefghijkl");
    expect(text).not.toMatch(/ch_1|bnd_1|revision|updated_at|_json/);
    const pairs = vf.auditPairs({ changed: ["name", "rpm"], token: "fgw_0123456789abcdef" });
    expect(pairs).toEqual([
      { label: "修改的字段", value: "名称, RPM" },
      { label: "token", value: "fgw…cdef" },
    ]);
  });

  it("U11: Enter sends, Shift+Enter and IME composition do not", async () => {
    const pg = await import("../../console/src/pages/playground");
    const k = (o: Partial<KeyboardEvent>) => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...o });
    expect(pg.isSendKey(k({}))).toBe(true);
    expect(pg.isSendKey(k({ shiftKey: true }))).toBe(false);
    expect(pg.isSendKey(k({ isComposing: true }))).toBe(false);
    expect(pg.isSendKey(k({ keyCode: 229 }))).toBe(false);
    expect(pg.isSendKey(k({ key: "a" }))).toBe(false);
  });

  it("B6: a bad usage query is caught before the request, in Chinese", async () => {
    const u = await import("../../console/src/pages/usage");
    expect(u.usageProblem("2026-11-06", "2026-11-01", "UTC")).toBe("开始日期不能晚于结束日期");
    expect(u.usageProblem("2026-11-01", "2026-11-06", "Mars/Base")).toContain("不是有效的时区");
    expect(u.usageProblem("2026-11-01", "2026-11-06", "Asia/Shanghai")).toBeUndefined();
  });

  it("U6 / U8: loadbalance bindings are one weighted set; logs show key names", async () => {
    const g = mod.models.bindingGroups({
      strategy: "loadbalance",
      bindings: [
        { channel: "a", upstreamModel: "x", priority: 0, weight: 3 },
        { channel: "b", upstreamModel: "y", priority: 1, weight: 1 },
      ],
    });
    expect(g.balanced).toBe(true);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]!.map((b) => b.share)).toEqual([75, 25]);
    const f = mod.models.bindingGroups({
      strategy: "fallback",
      bindings: [
        { channel: "a", upstreamModel: "x", priority: 0 },
        { channel: "b", upstreamModel: "y", priority: 1 },
      ],
    });
    expect(f.groups).toHaveLength(2);
    const logs = await import("../../console/src/pages/logs");
    const names = new Map([["644fb848-0555-4d00-bf31-2d18413d0545", "probe-all"]]);
    expect(logs.keyLabel({ keyId: "644fb848-0555-4d00-bf31-2d18413d0545" }, names)).toBe("probe-all");
    expect(logs.keyLabel({ keyId: "644fb848-0555-4d00-bf31-2d18413d0545", keyName: "srv" }, names)).toBe("srv");
    expect(logs.keyLabel({ keyId: "11111111-2222-3333-4444-555555555555" }, names)).toBe("11111111");
    expect(logs.keyLabel({ keyId: "console-playground", keyKind: "console" }, names)).toBe("控制台调试台");
  });

  it("U5: two keys with the same last four characters are told apart", () => {
    const k = (id: string, hint: string) => ({ id, hint }) as never;
    const hints = mod.channels.keyHints([k("a", "sk-…6789"), k("b", "sk-…6789"), k("c", "sk-…aaaa")]);
    expect([...hints.values()]).toEqual(["sk-…6789 · 第 1 个", "sk-…6789 · 第 2 个", "sk-…aaaa"]);
  });
});
