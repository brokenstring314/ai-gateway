/**
 * Runtime-config Admin API (0.3.0 P4): channels, keys, models, settings,
 * versions/rollback, audit, presets — permissions, CSRF, optimistic
 * concurrency (428/409), transactional apply (422 + rollback), SSRF, and
 * that upstream keys never come back in plaintext.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { adminHarness, FakeUpstreams, type Harness, yamlTarget } from "./_admin-harness.js";

const up = new FakeUpstreams();
beforeAll(() => up.install());
afterAll(() => up.uninstall());
afterEach(() => up.reset());

const NEW_KEY_1 = "sk-admin-created-key-1111aaaa";
const NEW_KEY_2 = "sk-admin-created-key-2222bbbb";

function explicitFile(extra: Record<string, unknown> = {}) {
  return {
    strategy: { mode: "fallback", targets: ["a", "b"] },
    targets: [yamlTarget("a"), yamlTarget("b")],
    models: [{ name: "gpt-x", bindings: [{ target: "a" }, { target: "b" }] }],
    aliases: { fast: "gpt-x" },
    ...extra,
  };
}

async function json(r: Response): Promise<any> {
  return r.json();
}

async function createChannel(h: Harness, body: Record<string, unknown> = {}) {
  const r = await h.admin("POST", "/channels", {
    name: "c",
    preset: "openai",
    baseURL: "https://c.upstream.test/v1",
    keys: [{ key: NEW_KEY_1 }, { key: NEW_KEY_2 }],
    ...body,
  });
  return { r, body: await json(r) };
}

describe("channels", () => {
  it("create → list → get, keys only as hints, version + audit recorded", async () => {
    const h = await adminHarness(explicitFile());
    const before = await json(await h.admin("GET", "/config/versions"));
    const { r, body } = await createChannel(h);
    expect(r.status).toBe(201);
    expect(r.headers.get("etag")).toBe(`"${body.revision}"`);
    expect(body).toMatchObject({ name: "c", preset: "openai", urlPolicy: "public", enabled: true });
    expect(body.keys.map((k: { hint: string }) => k.hint)).toEqual(["sk-…aaaa", "sk-…bbbb"]);
    expect(body.configVersion).toBe(before.head + 1);
    const all = await (await h.admin("GET", "/channels")).text();
    for (const text of [JSON.stringify(body), all]) {
      expect(text).not.toContain(NEW_KEY_1);
      expect(text).not.toContain(NEW_KEY_2);
    }
    const one = await h.admin("GET", `/channels/${body.id}`);
    expect(one.status).toBe(200);
    expect((await json(one)).keys).toHaveLength(2);
    const audit = (await json(await h.admin("GET", "/audit?limit=1"))).data[0];
    expect(audit).toMatchObject({ action: "create", resourceType: "channel", resourceId: body.id });
    expect(audit.actor).toMatch(/^key:/);
    expect(JSON.stringify(audit)).not.toContain(NEW_KEY_1);
    const version = await (await h.admin("GET", `/config/versions/${body.configVersion}`)).text();
    expect(version).not.toContain(NEW_KEY_1);
    expect(version).not.toContain('"value"');
    // /admin/config (scrubbed) shows the live config without the plaintext either.
    const cfg = await (await h.admin("GET", "/config")).text();
    expect(cfg).toContain('"c"');
    expect(cfg).not.toContain(NEW_KEY_1);
  });

  it("a new channel serves traffic once bound; its keys rotate round robin", async () => {
    const h = await adminHarness(explicitFile());
    const { body: ch } = await createChannel(h);
    const models = await json(await h.admin("GET", "/models"));
    const m = models.data.find((x: { name: string }) => x.name === "gpt-x");
    const put = await h.admin(
      "PUT",
      `/models/${m.id}/bindings`,
      { bindings: [{ channelId: ch.id, upstreamModel: "up-x" }] },
      { ifMatch: m.revision },
    );
    expect(put.status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await h.chat("gpt-x")).status).toBe(200);
    const calls = up.hits("c.upstream.test");
    expect(calls.map((c) => c.body.model)).toEqual(["up-x", "up-x", "up-x", "up-x"]);
    expect(calls.map((c) => c.auth)).toEqual([
      `Bearer ${NEW_KEY_1}`,
      `Bearer ${NEW_KEY_2}`,
      `Bearer ${NEW_KEY_1}`,
      `Bearer ${NEW_KEY_2}`,
    ]);
  });

  it("If-Match: missing → 428, stale → 409 with the current revision, right → 200", async () => {
    const h = await adminHarness(explicitFile());
    const { body: ch } = await createChannel(h);
    expect((await h.admin("PATCH", `/channels/${ch.id}`, { priority: 9 })).status).toBe(428);
    const stale = await h.admin("PATCH", `/channels/${ch.id}`, { priority: 9 }, { ifMatch: ch.revision - 1 });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toMatchObject({ code: "revision_mismatch", currentRevision: ch.revision });
    expect((await h.admin("PATCH", `/channels/${ch.id}`, { priority: 9 }, { ifMatch: "garbage" })).status).toBe(400);
    const ok = await h.admin("PATCH", `/channels/${ch.id}`, { priority: 9 }, { ifMatch: `W/"${ch.revision}"` });
    expect(ok.status).toBe(200);
    const after = await json(ok);
    expect(after.priority).toBe(9);
    expect(after.revision).toBeGreaterThan(ch.revision);
    // The old ETag is now stale.
    expect((await h.admin("PATCH", `/channels/${ch.id}`, { priority: 1 }, { ifMatch: ch.revision })).status).toBe(409);
  });

  it("two writers with the same ETag: exactly one wins", async () => {
    const h = await adminHarness(explicitFile());
    const { body: ch } = await createChannel(h);
    const results = await Promise.all(
      [1, 2, 3].map((p) => h.admin("PATCH", `/channels/${ch.id}`, { priority: p }, { ifMatch: ch.revision })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  it("a bound channel cannot be deleted (409); unbound it can", async () => {
    const h = await adminHarness(explicitFile());
    const a = (await json(await h.admin("GET", "/channels"))).data.find((c: { name: string }) => c.name === "a");
    const del = await h.admin("DELETE", `/channels/${a.id}`, undefined, { ifMatch: a.revision });
    expect(del.status).toBe(409);
    expect((await json(del)).error.code).toBe("channel_in_use");
    const { body: ch } = await createChannel(h);
    expect((await h.admin("DELETE", `/channels/${ch.id}`)).status).toBe(428);
    const gone = await h.admin("DELETE", `/channels/${ch.id}`, undefined, { ifMatch: ch.revision });
    expect(gone.status).toBe(200);
    expect((await h.admin("GET", `/channels/${ch.id}`)).status).toBe(404);
  });

  it("strict bodies: unknown fields, env references in keys, bad JSON", async () => {
    const h = await adminHarness(explicitFile());
    const unknown = await h.admin("POST", "/channels", {
      name: "x",
      preset: "openai",
      baseURL: "https://x.upstream.test",
      oops: 1,
    });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).error.message).toContain("oops");
    const envKey = await createChannel(h, { name: "x", keys: [{ key: "${GATEWAY_SECRET_KEY}" }] });
    expect(envKey.r.status).toBe(400);
    const envUrl = await createChannel(h, { name: "x", baseURL: "https://x.upstream.test/${GATEWAY_SECRET_KEY}" });
    expect(envUrl.r.status).toBe(422);
    const settings = await createChannel(h, { name: "x", settings: { apiKey: "sneaky" } });
    expect(settings.r.status).toBe(400);
    expect((await h.admin("POST", "/channels", "{not json")).status).toBe(400);
  });

  it("name collisions are 409", async () => {
    const h = await adminHarness(explicitFile());
    const dup = await createChannel(h, { name: "a" });
    expect(dup.r.status).toBe(409);
    expect(dup.body.error.code).toBe("name_taken");
  });
});

describe("channel keys", () => {
  it("add, disable, enable, delete keys with If-Match on the channel", async () => {
    const h = await adminHarness(explicitFile());
    const { body: ch } = await createChannel(h, { keys: [{ key: NEW_KEY_1 }] });
    const add = await h.admin(
      "POST",
      `/channels/${ch.id}/keys`,
      { keys: [{ key: NEW_KEY_2, weight: 2 }] },
      { ifMatch: ch.revision },
    );
    expect(add.status).toBe(201);
    const added = await json(add);
    expect(added.keys.map((k: { hint: string; weight: number }) => [k.hint, k.weight])).toEqual([
      ["sk-…aaaa", 1],
      ["sk-…bbbb", 2],
    ]);
    const k2 = added.keys[1].id;
    expect(
      (await h.admin("POST", `/channels/${ch.id}/keys/${k2}/disable`, undefined, { ifMatch: ch.revision })).status,
    ).toBe(409);
    const dis = await json(
      await h.admin("POST", `/channels/${ch.id}/keys/${k2}/disable`, undefined, { ifMatch: added.revision }),
    );
    expect(dis.keys[1].enabled).toBe(false);
    const en = await json(
      await h.admin("POST", `/channels/${ch.id}/keys/${k2}/enable`, undefined, { ifMatch: dis.revision }),
    );
    expect(en.keys[1].enabled).toBe(true);
    const patched = await json(
      await h.admin("PATCH", `/channels/${ch.id}/keys/${k2}`, { weight: 0 }, { ifMatch: en.revision }),
    );
    expect(patched.keys[1].weight).toBe(0);
    const del = await json(
      await h.admin("DELETE", `/channels/${ch.id}/keys/${k2}`, undefined, { ifMatch: patched.revision }),
    );
    expect(del.keys).toHaveLength(1);
    expect((await h.admin("DELETE", `/channels/${ch.id}/keys/nope`, undefined, { ifMatch: del.revision })).status).toBe(
      404,
    );
  });

  it("a key answered 401 is disabled (persisted + audited), the request moves on to the next key", async () => {
    const h = await adminHarness(explicitFile({ models: [{ name: "gpt-x", bindings: [{ target: "a" }] }] }));
    const a = (await json(await h.admin("GET", "/channels"))).data.find((c: { name: string }) => c.name === "a");
    const added = await json(
      await h.admin("POST", `/channels/${a.id}/keys`, { keys: [{ key: NEW_KEY_2 }] }, { ifMatch: a.revision }),
    );
    up.byAuth.set("a.upstream.test", (auth) =>
      auth === "Bearer sk-yaml-a-0123456789"
        ? { status: 401, body: { error: { message: "Incorrect API key provided: sk-yaml-a-0123456789" } } }
        : undefined,
    );
    for (let i = 0; i < 3; i++) expect((await h.chat("gpt-x")).status).toBe(200);
    expect(up.hits("a.upstream.test").filter((c) => c.auth === "Bearer sk-yaml-a-0123456789")).toHaveLength(1);
    await Bun.sleep(20); // persisted asynchronously
    const after = await json(await h.admin("GET", `/channels/${a.id}`));
    const bad = after.keys[0];
    expect(bad.status).toBe("invalid");
    expect(bad.lastError).toContain("401");
    expect(bad.lastError).not.toContain("sk-yaml-a-0123456789");
    const audit = (await json(await h.admin("GET", "/audit?limit=5"))).data;
    expect(audit[0]).toMatchObject({ action: "key_auto_disabled", resourceType: "channel_key", resourceId: bad.id });
    // Re-enabling clears the status and the in-memory state.
    up.byAuth.clear();
    const en = await json(
      await h.admin("POST", `/channels/${a.id}/keys/${bad.id}/enable`, undefined, { ifMatch: added.revision }),
    );
    expect(en.keys[0].status).toBe("ok");
    up.reset();
    for (let i = 0; i < 4; i++) await h.chat("gpt-x");
    expect(up.hits("a.upstream.test").some((c) => c.auth === "Bearer sk-yaml-a-0123456789")).toBe(true);
  });
});

describe("permissions and CSRF", () => {
  it("read_only may GET everything but write nothing; inference keys get 403; no credential 401", async () => {
    const h = await adminHarness(explicitFile());
    for (const path of ["/channels", "/models", "/settings", "/config/versions", "/audit", "/presets"]) {
      expect((await h.admin("GET", path, undefined, { key: h.keys.readOnly })).status).toBe(200);
      expect((await h.admin("GET", path, undefined, { key: h.keys.inference })).status).toBe(403);
      expect((await h.admin("GET", path, undefined, { key: null })).status).toBe(401);
    }
    const ro = await h.admin(
      "POST",
      "/channels",
      { name: "x", preset: "openai", baseURL: "https://x.upstream.test" },
      { key: h.keys.readOnly },
    );
    expect(ro.status).toBe(403);
    expect((await h.admin("PATCH", "/settings", { aliases: {} }, { key: h.keys.readOnly, ifMatch: 1 })).status).toBe(
      403,
    );
    expect(
      (await h.admin("POST", "/config/versions/1/rollback", undefined, { key: h.keys.readOnly, ifMatch: 1 })).status,
    ).toBe(403);
    expect((await json(await h.admin("GET", "/channels"))).data).toHaveLength(2);
  });

  it("refuses cross-site and form-encoded writes", async () => {
    const h = await adminHarness(explicitFile());
    const body = { name: "x", preset: "openai", baseURL: "https://x.upstream.test" };
    const evil = await h.admin("POST", "/channels", body, { headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect((await json(evil)).error.code).toBe("csrf_rejected");
    expect((await h.admin("POST", "/channels", body, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(
      403,
    );
    const form = await h.admin("POST", "/channels", "name=x", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(415);
    const same = await h.admin("POST", "/channels", body, {
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
    });
    expect(same.status).toBe(201);
  });
});

describe("transactional apply: build failure → 422, nothing changes", () => {
  it("an invalid result is rolled back and the old config keeps serving", async () => {
    const h = await adminHarness(explicitFile());
    const versionsBefore = (await json(await h.admin("GET", "/config/versions"))).head;
    const auditBefore = (await json(await h.admin("GET", "/audit"))).data.length;
    const settings = await json(await h.admin("GET", "/settings"));
    const bad = await h.admin(
      "PATCH",
      "/settings",
      { strategy: { mode: "fallback", targets: ["a", "ghost"] } },
      { ifMatch: settings.revision },
    );
    expect(bad.status).toBe(422);
    const err = (await json(bad)).error;
    expect(err.code).toBe("config_invalid");
    expect(err.message).toContain("ghost");
    expect((await json(await h.admin("GET", "/config/versions"))).head).toBe(versionsBefore);
    expect((await json(await h.admin("GET", "/audit"))).data.length).toBe(auditBefore);
    expect((await json(await h.admin("GET", "/settings"))).strategy.targets).toEqual(["a", "b"]);
    expect(h.gateway.getConfig().strategy.targets).toEqual(["a", "b"]);
    expect((await h.chat("gpt-x")).status).toBe(200);
  });

  it("deleting a model an alias points to is refused with the reason", async () => {
    const h = await adminHarness(explicitFile());
    const m = (await json(await h.admin("GET", "/models"))).data[0];
    const del = await h.admin("DELETE", `/models/${m.id}`, undefined, { ifMatch: m.revision });
    expect(del.status).toBe(422);
    expect((await json(del)).error.message).toContain('alias "fast"');
    expect((await h.chat("fast")).status).toBe(200);
  });

  it("a model promising more than its upstream allows is refused (startup validation runs)", async () => {
    const h = await adminHarness({
      strategy: { mode: "single", targets: ["ds"] },
      targets: [{ ...yamlTarget("ds", ["deepseek-v4-flash"]), provider: "deepseek" }],
      models: [{ name: "ds", bindings: [{ target: "ds", model: "deepseek-v4-flash" }] }],
    });
    const m = (await json(await h.admin("GET", "/models"))).data[0];
    const r = await h.admin(
      "PATCH",
      `/models/${m.id}`,
      { metadata: { maxOutputTokens: 99_000_000 } },
      { ifMatch: m.revision },
    );
    expect(r.status).toBe(422);
    expect((await json(r)).error.message).toContain("maxOutputTokens");
  });
});

describe("SSRF: Admin API base URLs are public internet only", () => {
  const cases: Array<[string, string]> = [
    ["loopback", "http://127.0.0.1:8080/v1"],
    ["metadata", "http://169.254.169.254/latest"],
    ["private", "http://10.0.0.5/v1"],
    ["ipv6 loopback", "http://[::1]/v1"],
    ["ipv4-mapped", "http://[::ffff:127.0.0.1]/v1"],
    ["localhost", "http://localhost:11434/v1"],
    ["credentials", "https://u:p@x.upstream.test/v1"],
  ];
  for (const [what, url] of cases) {
    it(`refuses ${what}`, async () => {
      const h = await adminHarness(explicitFile());
      const { r, body } = await createChannel(h, { baseURL: url });
      expect(r.status).toBe(422);
      expect(body.error.code).toBe("unsafe_base_url");
      // P7 regression: the console places the refusal on the Base URL field.
      expect(body.error.fields).toEqual([{ path: "baseURL", message: body.error.message }]);
    });
  }

  it("refuses a name resolving to a private address, an unresolvable name, and a local-only preset default", async () => {
    const h = await adminHarness(explicitFile());
    h.dns.set("inside.upstream.test", ["192.168.1.20"]);
    expect((await createChannel(h, { baseURL: "https://inside.upstream.test/v1" })).r.status).toBe(422);
    expect((await createChannel(h, { baseURL: "https://nx.upstream.test/v1" })).r.status).toBe(422);
    const ollama = await createChannel(h, { preset: "ollama", baseURL: undefined });
    expect(ollama.r.status).toBe(422);
    expect(ollama.body.error.message).toContain("local name");
  });

  it("PATCH to a private address is refused; the channel keeps its URL", async () => {
    const h = await adminHarness(explicitFile());
    const { body: ch } = await createChannel(h);
    const r = await h.admin(
      "PATCH",
      `/channels/${ch.id}`,
      { baseURL: "http://192.168.0.1/v1" },
      { ifMatch: ch.revision },
    );
    expect(r.status).toBe(422);
    expect((await json(await h.admin("GET", `/channels/${ch.id}`))).baseURL).toBe("https://c.upstream.test/v1");
  });

  it("changing a config-file channel's URL makes it public-only", async () => {
    const h = await adminHarness(explicitFile());
    const a = (await json(await h.admin("GET", "/channels"))).data.find((c: { name: string }) => c.name === "a");
    expect(a.urlPolicy).toBe("trusted");
    const r = await json(
      await h.admin(
        "PATCH",
        `/channels/${a.id}`,
        // A new origin needs its key(s) again (RC1).
        { baseURL: "https://a2.upstream.test/v1", apiKeys: [{ key: NEW_KEY_1 }] },
        { ifMatch: a.revision },
      ),
    );
    expect(r.urlPolicy).toBe("public");
  });

  it("DNS rebinding: a name that later resolves inside is refused at request time", async () => {
    const h = await adminHarness(
      explicitFile({
        models: [{ name: "gpt-x", bindings: [{ target: "c" }] }],
        targets: [yamlTarget("a"), yamlTarget("b"), yamlTarget("c")],
        strategy: { mode: "fallback", targets: ["a"] },
      }),
    );
    const c = (await json(await h.admin("GET", "/channels"))).data.find((x: { name: string }) => x.name === "c");
    // Re-point c (config-file channel) at an admin URL: now public-only.
    await h.admin(
      "PATCH",
      `/channels/${c.id}`,
      { baseURL: "https://rebind.upstream.test/v1", apiKeys: [{ key: NEW_KEY_1 }] },
      { ifMatch: c.revision },
    );
    expect((await h.chat("gpt-x")).status).toBe(200);
    expect(up.hits("rebind.upstream.test")).toHaveLength(1);
    h.dns.set("rebind.upstream.test", ["169.254.169.254"]);
    const r = await h.chat("gpt-x");
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("169.254");
    expect(up.hits("rebind.upstream.test")).toHaveLength(1);
  });
});

describe("models and the unavailable-model fix", () => {
  it("U3/U4: null or an empty display name / description clears it; null keyCooldownSeconds reverts to the default", async () => {
    const h = await adminHarness(explicitFile());
    const created = await h.admin("POST", "/models", {
      name: "clearable",
      displayName: "   ",
      description: "",
      bindings: [{ channel: "a", upstreamModel: "m" }],
    });
    expect(created.status).toBe(201);
    let m = await json(created);
    expect(m.displayName).toBeNull();
    expect(m.description).toBeNull();
    let r = await h.admin(
      "PATCH",
      `/models/${m.id}`,
      { displayName: "Shown", description: "Text" },
      { ifMatch: m.revision },
    );
    m = await json(r);
    expect(m).toMatchObject({ displayName: "Shown", description: "Text" });
    r = await h.admin("PATCH", `/models/${m.id}`, { displayName: null, description: "" }, { ifMatch: m.revision });
    expect(r.status).toBe(200);
    m = await json(await h.admin("GET", `/models/${m.id}`));
    expect(m.displayName).toBeNull();
    expect(m.description).toBeNull();

    const a = (await json(await h.admin("GET", "/channels"))).data.find((c: { name: string }) => c.name === "a");
    r = await h.admin("PATCH", `/channels/${a.id}`, { keyCooldownSeconds: 60 }, { ifMatch: a.revision });
    const ch = await json(r);
    expect(ch.keyCooldownSeconds).toBe(60);
    r = await h.admin("PATCH", `/channels/${a.id}`, { keyCooldownSeconds: null }, { ifMatch: ch.revision });
    expect(r.status).toBe(200);
    expect((await json(await h.admin("GET", `/channels/${a.id}`))).keyCooldownSeconds).toBeNull();
  });

  it("create a model with priority groups; the next group is used only when the first fails", async () => {
    const h = await adminHarness({
      strategy: { mode: "fallback" },
      targets: [yamlTarget("p1"), yamlTarget("p2"), yamlTarget("backup")],
      models: [{ name: "seed", bindings: [{ target: "p1" }] }],
    });
    const r = await h.admin("POST", "/models", {
      name: "grouped",
      balance: "round_robin",
      bindings: [
        { channel: "p1", priority: 0, upstreamModel: "m" },
        { channel: "p2", priority: 0, upstreamModel: "m" },
        { channel: "backup", priority: 1, upstreamModel: "m" },
      ],
    });
    expect(r.status).toBe(201);
    const m = await json(r);
    expect(m).toMatchObject({ balance: "round_robin", strategy: "fallback", available: true });
    for (let i = 0; i < 4; i++) await h.chat("grouped");
    expect(up.hits("p1.upstream.test")).toHaveLength(2);
    expect(up.hits("p2.upstream.test")).toHaveLength(2);
    expect(up.hits("backup.upstream.test")).toHaveLength(0);
    up.reset();
    up.enqueue("p1.upstream.test", 500);
    up.enqueue("p2.upstream.test", 500);
    const res = await h.chat("grouped");
    expect(res.status).toBe(200);
    expect((await json(res)).choices[0].message.content).toBe("backup:m");
  });

  it("a model whose channels are all disabled stays published: 503 model_unavailable, aliases keep resolving", async () => {
    const h = await adminHarness(explicitFile());
    const channels = (await json(await h.admin("GET", "/channels"))).data;
    for (const ch of channels) {
      expect((await h.admin("PATCH", `/channels/${ch.id}`, { enabled: false }, { ifMatch: ch.revision })).status).toBe(
        200,
      );
    }
    for (const name of ["gpt-x", "fast"]) {
      const r = await h.chat(name);
      expect(r.status).toBe(503);
      expect((await json(r)).error.code).toBe("model_unavailable");
    }
    const listed = await json(
      await h.app.request("/v1/models", { headers: { authorization: `Bearer ${h.keys.inference}` } }),
    );
    expect(listed.data.find((m: { id: string }) => m.id === "gpt-x")).toMatchObject({ available: false });
    const model = (await json(await h.admin("GET", "/models"))).data[0];
    expect(model.available).toBe(false);
    const a = (await json(await h.admin("GET", "/channels"))).data.find((c: { name: string }) => c.name === "a");
    await h.admin("PATCH", `/channels/${a.id}`, { enabled: true }, { ifMatch: a.revision });
    expect((await h.chat("fast")).status).toBe(200);
  });

  it("model writes need explicit models; PATCH settings modelSource=explicit materializes the derived list", async () => {
    const h = await adminHarness({
      strategy: { mode: "loadbalance", weights: { a: 3, b: 1 } },
      targets: [yamlTarget("a", ["m1", "m2"]), yamlTarget("b", ["m1"])],
    });
    const r = await h.admin("POST", "/models", { name: "new" });
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe("models_derived");
    const s = await json(await h.admin("GET", "/settings"));
    expect(s.modelSource).toBe("derived");
    const sw = await h.admin("PATCH", "/settings", { modelSource: "explicit" }, { ifMatch: s.revision });
    expect(sw.status).toBe(200);
    const models = (await json(await h.admin("GET", "/models"))).data;
    const m1 = models.find((m: { name: string }) => m.name === "m1");
    expect(m1.strategy).toBe("loadbalance");
    expect(m1.bindings.map((b: { channel: string; weight: number }) => [b.channel, b.weight])).toEqual([
      ["a", 3],
      ["b", 1],
    ]);
    expect((await h.chat("m2")).status).toBe(200);
    expect(
      (await h.admin("POST", "/models", { name: "new", bindings: [{ channel: "a", upstreamModel: "m1" }] })).status,
    ).toBe(201);
    expect((await h.chat("new")).status).toBe(200);
  });

  it("binding an unknown channel is 422; renaming a model keeps its bindings", async () => {
    const h = await adminHarness(explicitFile());
    const bad = await h.admin("POST", "/models", { name: "z", bindings: [{ channel: "ghost" }] });
    expect(bad.status).toBe(422);
    const m = (await json(await h.admin("GET", "/models"))).data[0];
    const settings = await json(await h.admin("GET", "/settings"));
    await h.admin("PATCH", "/settings", { aliases: {} }, { ifMatch: settings.revision });
    const renamed = await json(
      await h.admin(
        "PATCH",
        `/models/${(await json(await h.admin("GET", `/models/${m.id}`))).id}`,
        { name: "gpt-y" },
        { ifMatch: (await json(await h.admin("GET", `/models/${m.id}`))).revision },
      ),
    );
    expect(renamed.bindings.map((b: { upstreamModel: string }) => b.upstreamModel)).toEqual(["gpt-x", "gpt-x"]);
    const res = await h.chat("gpt-y");
    expect((await json(res)).choices[0].message.content).toBe("a:gpt-x");
  });
});

describe("settings, versions, rollback", () => {
  it("aliases and plugins via PATCH /settings take effect at once", async () => {
    const h = await adminHarness(explicitFile());
    const s = await json(await h.admin("GET", "/settings"));
    const r = await h.admin(
      "PATCH",
      "/settings",
      {
        aliases: { fast: "gpt-x", quick: "gpt-x" },
        plugins: [{ name: "word-filter", stage: "before_request", config: { blockedWords: ["forbidden"] } }],
      },
      { ifMatch: s.revision },
    );
    expect(r.status).toBe(200);
    expect((await h.chat("quick")).status).toBe(200);
    const blocked = await h.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${h.keys.inference}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "a forbidden word" }] }),
    });
    expect(blocked.status).toBe(403);
    const stale = await h.admin("PATCH", "/settings", { aliases: {} }, { ifMatch: s.revision });
    expect(stale.status).toBe(409);
  });

  it("limits.maxOutputTokens via PATCH /settings applies at once (RB6); null restores the default", async () => {
    const h = await adminHarness(explicitFile());
    const send = (maxTokens: number) =>
      h.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${h.keys.inference}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "hi" }], max_tokens: maxTokens }),
      });
    const s = await json(await h.admin("GET", "/settings"));
    expect(s.limits).toEqual({});
    expect((await send(9_999_999)).status).toBe(400);
    const r = await h.admin("PATCH", "/settings", { limits: { maxOutputTokens: 500 } }, { ifMatch: s.revision });
    expect(r.status).toBe(200);
    const after = await json(r);
    expect(after.limits).toEqual({ maxOutputTokens: 500 });
    const over = await send(501);
    expect(over.status).toBe(400);
    expect((await json(over)).error).toMatchObject({ code: "max_tokens_exceeded", param: "max_tokens" });
    expect((await send(500)).status).toBe(200);
    expect(
      (await h.admin("PATCH", "/settings", { limits: { maxOutputTokens: 0 } }, { ifMatch: after.revision })).status,
    ).toBe(400);
    const reset = await h.admin("PATCH", "/settings", { limits: null }, { ifMatch: after.revision });
    expect((await json(reset)).limits).toEqual({});
    expect((await send(65_536)).status).toBe(200);
  });

  it("rollback restores an earlier version (If-Match = head), revisions keep growing", async () => {
    const h = await adminHarness(explicitFile());
    const head0 = (await json(await h.admin("GET", "/config/versions"))).head;
    const { body: ch } = await createChannel(h);
    const head1 = (await json(await h.admin("GET", "/config/versions"))).head;
    expect(head1).toBe(head0 + 1);
    expect((await h.admin("POST", `/config/versions/${head0}/rollback`)).status).toBe(428);
    expect((await h.admin("POST", `/config/versions/${head0}/rollback`, undefined, { ifMatch: head0 })).status).toBe(
      409,
    );
    const rb = await h.admin("POST", `/config/versions/${head0}/rollback`, undefined, { ifMatch: head1 });
    expect(rb.status).toBe(200);
    expect(await json(rb)).toMatchObject({ rolledBackTo: head0, configVersion: head1 + 1 });
    expect((await h.admin("GET", `/channels/${ch.id}`)).status).toBe(404);
    expect(h.gateway.getConfig().targets.map((t) => t.name)).toEqual(["a", "b"]);
    const a = (await json(await h.admin("GET", "/channels"))).data[0];
    expect(a.revision).toBe(head1 + 1);
    // Roll forward again: the created channel (and its encrypted keys) come back and serve.
    const fwd = await h.admin("POST", `/config/versions/${head1}/rollback`, undefined, { ifMatch: head1 + 1 });
    expect(fwd.status).toBe(200);
    const back = await json(await h.admin("GET", `/channels/${ch.id}`));
    expect(back.keys).toHaveLength(2);
    expect((await h.admin("GET", "/config/versions/999")).status).toBe(404);
    expect((await h.admin("POST", "/config/versions/999/rollback", undefined, { ifMatch: head1 + 2 })).status).toBe(
      404,
    );
    const list = await json(await h.admin("GET", "/config/versions?limit=2"));
    expect(list.data.map((v: { version: number }) => v.version)).toEqual([head1 + 2, head1 + 1]);
    expect(list.data[0].summary).toContain(`Roll back to config version ${head1}`);
  });
});

describe("file source: read-only", () => {
  it("lists the file's config and refuses writes", async () => {
    const h = await adminHarness(explicitFile({ runtimeConfig: { source: "file" } }), { store: false });
    const list = await json(await h.admin("GET", "/channels"));
    expect(list).toMatchObject({ source: "file", readOnly: true });
    expect(list.data.map((c: { name: string }) => c.name)).toEqual(["a", "b"]);
    expect(JSON.stringify(list)).not.toContain("sk-yaml-a-0123456789");
    const w = await createChannel(h);
    expect(w.r.status).toBe(403);
    expect(w.body.error.code).toBe("config_read_only");
    expect((await h.admin("PATCH", "/settings", { aliases: {} }, { ifMatch: 0 })).status).toBe(403);
    expect((await json(await h.admin("GET", "/config/versions"))).data).toEqual([]);
  });
});

describe("presets, channel test, fetch models", () => {
  it("GET /presets lists providers and known models", async () => {
    const h = await adminHarness(explicitFile());
    const p = await json(await h.admin("GET", "/presets"));
    const ds = p.data.find((x: { id: string }) => x.id === "deepseek");
    expect(ds.baseURL).toBe("https://api.deepseek.com/v1");
    expect(ds.models.map((m: { id: string }) => m.id)).toContain("deepseek-v4-flash");
    expect(p.data.find((x: { id: string }) => x.id === "ollama").adminUsable).toBe(false);
  });

  it("fetch-models returns the upstream ids; test reports status and latency without the key", async () => {
    const h = await adminHarness(explicitFile());
    const { body: ch } = await createChannel(h);
    const fm = await json(await h.admin("POST", `/channels/${ch.id}/fetch-models`));
    expect(fm.models).toEqual(["up-model-1", "up-model-2"]);
    expect(up.hits("c.upstream.test")[0]?.auth).toBe(`Bearer ${NEW_KEY_1}`);
    const ok = await json(await h.admin("POST", `/channels/${ch.id}/test`, { model: "up-model-1" }));
    expect(ok).toMatchObject({ ok: true, status: 200, model: "up-model-1" });
    up.enqueue("c.upstream.test", { status: 401, body: { error: { message: `bad key ${NEW_KEY_1}` } } });
    const bad = await json(await h.admin("POST", `/channels/${ch.id}/test`, {}));
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(401);
    expect(JSON.stringify(bad)).not.toContain(NEW_KEY_1);
    up.enqueue("c.upstream.test", { status: 302, headers: { location: "http://169.254.169.254/" }, text: "" });
    const redirect = await json(await h.admin("POST", `/channels/${ch.id}/test`, {}));
    expect(redirect.ok).toBe(false);
    expect(redirect.error).toContain("redirect");
    // The probes are rate limited and never available to read_only.
    expect((await h.admin("POST", `/channels/${ch.id}/test`, {}, { key: h.keys.readOnly })).status).toBe(403);
  });

  it("probes are rate limited per caller", async () => {
    const h = await adminHarness(explicitFile(), { probe: { perActorPerMinute: 2 } });
    const { body: ch } = await createChannel(h);
    expect((await h.admin("POST", `/channels/${ch.id}/test`, {})).status).toBe(200);
    expect((await h.admin("POST", `/channels/${ch.id}/test`, {})).status).toBe(200);
    const limited = await h.admin("POST", `/channels/${ch.id}/test`, {});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("hot path", () => {
  it("serves requests with the config database closed (zero DB reads per request)", async () => {
    const h = await adminHarness(explicitFile());
    await createChannel(h);
    h.store.close();
    for (let i = 0; i < 10; i++)
      expect((await h.chat(i % 2 ? "gpt-x" : "fast", { stream: i % 3 === 0 })).status).toBe(200);
  });
});

describe("base URL credentials", () => {
  it("refuses a credential in the base URL query; listings scrub file-channel URLs", async () => {
    const h = await adminHarness({
      strategy: { mode: "single", targets: ["a"] },
      targets: [{ ...yamlTarget("a"), baseURL: "https://a.upstream.test/v1?api_key=sk-in-query-secret" }],
    });
    const r = await createChannel(h, { baseURL: "https://c.upstream.test/v1?key=abc" });
    expect(r.r.status).toBe(422);
    expect(r.body.error.code).toBe("unsafe_base_url");
    const list = await (await h.admin("GET", "/channels", undefined, { key: h.keys.readOnly })).text();
    expect(list).not.toContain("sk-in-query-secret");
    const head = (await json(await h.admin("GET", "/config/versions"))).head;
    expect(await (await h.admin("GET", `/config/versions/${head}`)).text()).not.toContain("sk-in-query-secret");
  });
});
