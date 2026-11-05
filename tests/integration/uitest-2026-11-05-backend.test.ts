/**
 * Backend fixes from the console real-usage UI test (2026-11-05):
 *  - B3  clients see the published model name (every surface, stream and
 *        non-stream); request_logs.model is the published name for successes
 *        and failures, upstreamModel holds the upstream's; usage by published name
 *  - B4  a rollback keeps the runtime health of a key the gateway disabled since
 *  - B5  /favicon.ico (+ /admin/…) is public; GET /admin/session/status never 401s
 *  - B7  published model names are checked (400 invalid_model_name); an enabled
 *        model needs a binding (400 model_no_bindings); old names only warn
 *  - U8  /admin/logs entries carry the key's name; /admin/session the key's name
 *  - U2  every admin error carries a stable `code`
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { RequestLogStore } from "../../src/persistence/request-log-store.js";
import { publishedModelWarnings } from "../../src/server/bootstrap.js";
import { Gateway } from "../../src/gateway.js";
import { loadConfigFromObject } from "../../src/config/loader.js";
import { adminHarness, FakeUpstreams, type Harness, yamlTarget } from "./_admin-harness.js";

const up = new FakeUpstreams();
beforeAll(() => up.install());
afterAll(() => up.uninstall());
afterEach(() => up.reset());

const KEY_2 = "sk-admin-created-key-2222bbbb";

/** `lb` is served by channel a as `up-a` and by channel b as `up-b`; `pub` keeps its name upstream. */
function file(extra: Record<string, unknown> = {}) {
  return {
    strategy: { mode: "single" },
    targets: [yamlTarget("a", ["up-a"]), yamlTarget("b", ["up-b"])],
    models: [
      {
        name: "lb",
        bindings: [
          { target: "a", model: "up-a" },
          { target: "b", model: "up-b" },
        ],
      },
      { name: "pub", bindings: [{ target: "b" }] },
    ],
    aliases: { fast: "lb" },
    ...extra,
  };
}

async function json(r: Response): Promise<any> {
  return r.json();
}

async function post(h: Harness, path: string, body: unknown): Promise<Response> {
  return h.app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${h.keys.inference}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Every `data:` JSON event of an SSE body. */
async function sseEvents(r: Response): Promise<any[]> {
  const text = await r.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

async function logsOf(h: Harness, query = ""): Promise<any[]> {
  await Bun.sleep(5);
  return (await json(await h.admin("GET", `/logs${query}`))).entries;
}

describe("B3: the published model name, never the upstream id", () => {
  it("chat, completions and embeddings answer with the published name, stream and non-stream", async () => {
    const h = await adminHarness(file());
    const chat = await json(await h.chat("lb"));
    expect(chat.model).toBe("lb");
    expect(up.calls[0]!.body.model).toBe("up-a"); // the upstream still got its own name

    const chunks = await sseEvents(await h.chat("lb", { stream: true }));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.model).toBe("lb");

    // An alias answers with the model it names.
    expect((await json(await h.chat("fast"))).model).toBe("lb");

    const comp = await json(await post(h, "/v1/completions", { model: "lb", prompt: "hi" }));
    expect(comp.object).toBe("text_completion");
    expect(comp.model).toBe("lb");
    const compChunks = await sseEvents(await post(h, "/v1/completions", { model: "lb", prompt: "hi", stream: true }));
    expect(compChunks.length).toBeGreaterThan(0);
    for (const c of compChunks) expect(c.model).toBe("lb");

    up.enqueue("a.upstream.test", {
      status: 200,
      body: {
        object: "list",
        model: "up-a",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    });
    const emb = await post(h, "/v1/embeddings", { model: "lb", input: "hi" });
    expect(emb.status).toBe(200);
    expect((await json(emb)).model).toBe("lb");
  });

  it("request_logs: model = published name for successes and failures, upstreamModel apart; ?model= finds both", async () => {
    const logStore = await RequestLogStore.create(new Database(":memory:"));
    const h = await adminHarness(file(), { logStore });
    expect((await h.chat("lb")).status).toBe(200);
    const streamed = await h.chat("lb", { stream: true });
    expect(streamed.status).toBe(200);
    await streamed.text(); // the stream is logged when it ends
    // Both channels fail: an upstream error, logged under the published name.
    up.enqueue("a.upstream.test", 500, 500, 500, 500);
    up.enqueue("b.upstream.test", 500, 500, 500, 500);
    expect((await h.chat("lb")).status).toBeGreaterThanOrEqual(500);
    // Rejected before any upstream: an unknown model keeps the name it was sent with.
    expect((await h.chat("nope")).status).toBe(404);

    const lb = await logsOf(h, "?model=lb");
    expect(lb).toHaveLength(3);
    for (const e of lb) expect(e.model).toBe("lb");
    const ok = lb.filter((e) => e.errorMessage === "");
    expect(ok).toHaveLength(2);
    for (const e of ok) expect(e.upstreamModel).toBe("up-a");
    const failed = lb.find((e) => e.errorMessage !== "");
    expect(["up-a", "up-b"]).toContain(failed.upstreamModel);
    // No published row is ever stored under the upstream's name.
    expect(await logsOf(h, "?model=up-a")).toHaveLength(0);
    expect((await logsOf(h, "?upstreamModel=up-a")).length).toBeGreaterThanOrEqual(2);
    const unknown = (await logsOf(h, "?model=nope"))[0];
    expect(unknown.status).toBe(404);
    expect(unknown.upstreamModel).toBeUndefined();

    // U8: the key's name is joined in at read time.
    for (const e of lb) expect(e).toMatchObject({ keyName: "inf", keyKind: "store" });

    // Usage stays by published name.
    const usage = await json(await h.admin("GET", "/usage?groupBy=model"));
    const models = (usage.data ?? usage.rows ?? []).map((r: { key?: string; model?: string }) => r.key ?? r.model);
    expect(models).toContain("lb");
    expect(models).not.toContain("up-a");
  });
});

describe("B4: rollback keeps the runtime key health", () => {
  async function channelA(h: Harness) {
    return (await json(await h.admin("GET", "/channels"))).data.find((c: { name: string }) => c.name === "a");
  }

  it("a key disabled after a 401 stays disabled when an earlier version is restored", async () => {
    const h = await adminHarness(file({ models: [{ name: "lb", bindings: [{ target: "a", model: "up-a" }] }] }));
    const a0 = await channelA(h);
    await h.admin("POST", `/channels/${a0.id}/keys`, { keys: [{ key: KEY_2 }] }, { ifMatch: a0.revision });
    const v1 = (await json(await h.admin("GET", "/config/versions"))).head;
    up.byAuth.set("a.upstream.test", (auth) =>
      auth === "Bearer sk-yaml-a-0123456789" ? { status: 401, body: { error: { message: "bad key" } } } : undefined,
    );
    for (let i = 0; i < 3; i++) expect((await h.chat("lb")).status).toBe(200);
    await Bun.sleep(20); // persisted asynchronously
    const dead = (await channelA(h)).keys[0];
    expect(dead.status).toBe("invalid");
    // A later change snapshots the invalid key; rolling back to v1 (where it was ok) must not revive it.
    const created = await h.admin("POST", "/models", {
      name: "other",
      bindings: [{ channel: "b", upstreamModel: "up-b" }],
    });
    expect(created.status).toBe(201);
    const head = (await json(await h.admin("GET", "/config/versions"))).head;
    const rb = await h.admin("POST", `/config/versions/${v1}/rollback`, undefined, { ifMatch: head });
    expect(rb.status).toBe(200);
    const after = (await channelA(h)).keys.find((k: { id: string }) => k.id === dead.id);
    expect(after.status).toBe("invalid");
    expect(after.lastError).toContain("401");
    up.reset();
    up.byAuth.set("a.upstream.test", (auth) =>
      auth === "Bearer sk-yaml-a-0123456789" ? { status: 401, body: { error: { message: "bad key" } } } : undefined,
    );
    for (let i = 0; i < 3; i++) expect((await h.chat("lb")).status).toBe(200);
    // The dead key is not tried again after the rollback.
    expect(up.hits("a.upstream.test").filter((c) => c.auth === "Bearer sk-yaml-a-0123456789")).toHaveLength(0);
  });

  it("a key that no longer exists comes back with the health its version recorded", async () => {
    const h = await adminHarness(file({ models: [{ name: "lb", bindings: [{ target: "a", model: "up-a" }] }] }));
    const a0 = await channelA(h);
    const added = await json(
      await h.admin("POST", `/channels/${a0.id}/keys`, { keys: [{ key: KEY_2 }] }, { ifMatch: a0.revision }),
    );
    const k2 = added.keys.find((k: { hint: string }) => k.hint === "sk-…bbbb");
    const v1 = (await json(await h.admin("GET", "/config/versions"))).head;
    await h.admin("DELETE", `/channels/${a0.id}/keys/${k2.id}`, undefined, { ifMatch: added.revision });
    const head = (await json(await h.admin("GET", "/config/versions"))).head;
    expect((await h.admin("POST", `/config/versions/${v1}/rollback`, undefined, { ifMatch: head })).status).toBe(200);
    const back = (await channelA(h)).keys.find((k: { id: string }) => k.id === k2.id);
    expect(back.status).toBe("ok");
  });
});

describe("B5: static icons and the sign-in probe", () => {
  it("favicons are public; unknown admin routes are JSON with a code", async () => {
    const h = await adminHarness(file());
    for (const path of ["/favicon.ico", "/admin/favicon.ico", "/admin/dashboard/favicon.ico"]) {
      const r = await h.app.request(path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/x-icon");
      const bytes = new Uint8Array(await r.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([0, 0, 1, 0]); // ICO header
    }
    const nf = await h.admin("GET", "/no-such-route");
    expect(nf.status).toBe(404);
    expect((await json(nf)).error.code).toBe("not_found");
  });

  it("GET /admin/session/status: 200 { authenticated: false } without a session, the session view with one", async () => {
    const h = await adminHarness(file());
    const anon = await h.app.request("/admin/session/status");
    expect(anon.status).toBe(200);
    expect(await json(anon)).toEqual({ authenticated: false });
    const stale = await h.app.request("/admin/session/status", { headers: { cookie: "aigw_session=bogus" } });
    expect(stale.status).toBe(200);
    expect((await json(stale)).authenticated).toBe(false);
    // The authenticated route itself still answers 401 without a credential (unchanged).
    expect((await h.app.request("/admin/session")).status).toBe(401);

    const ro = h.keyStore.create("viewer", ["read_only"]).key;
    const login = await h.app.request("/admin/session/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: ro }),
    });
    expect(login.status).toBe(200);
    expect(await json(login)).toMatchObject({ authenticated: true, keyName: "viewer" });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const st = await json(await h.app.request("/admin/session/status", { headers: { cookie } }));
    expect(st).toMatchObject({ authenticated: true, via: "session", keyName: "viewer", scopes: ["read_only"] });
    expect(typeof st.csrfToken).toBe("string");
    const sess = await json(await h.app.request("/admin/session", { headers: { cookie } }));
    expect(sess).toMatchObject({ authenticated: true, via: "session", keyName: "viewer" });
    // Header credential: the key's name too.
    expect(await json(await h.admin("GET", "/session"))).toMatchObject({
      authenticated: true,
      via: "header",
      keyName: "admin",
    });
  });
});

describe("B7: published model names and bindings", () => {
  it("rejects bad names (400 invalid_model_name) and enabled models without bindings (400 model_no_bindings)", async () => {
    const h = await adminHarness(file());
    const bind = [{ channel: "a", upstreamModel: "up-a" }];
    for (const name of ["bad name!", "x".repeat(257), "tab\there", "名字", ""]) {
      const r = await h.admin("POST", "/models", { name, bindings: bind });
      expect(r.status).toBe(400);
      const e = (await json(r)).error;
      expect(e.code).toBe("invalid_model_name");
      expect(e.param).toBe("name");
    }
    for (const name of ["@cf/meta/llama-3.1:8b", "a_b-c.d", "x".repeat(256)]) {
      const r = await h.admin("POST", "/models", { name, bindings: bind });
      expect(r.status).toBe(201);
    }
    const none = await h.admin("POST", "/models", { name: "empty" });
    expect(none.status).toBe(400);
    expect((await json(none)).error.code).toBe("model_no_bindings");
    expect((await h.admin("POST", "/models", { name: "empty", bindings: [] })).status).toBe(400);
    // A disabled draft may have none …
    const draft = await h.admin("POST", "/models", { name: "draft", enabled: false });
    expect(draft.status).toBe(201);
    const d = await json(draft);
    // … but cannot be enabled until it has one.
    const en = await h.admin("PATCH", `/models/${d.id}`, { enabled: true }, { ifMatch: d.revision });
    expect(en.status).toBe(400);
    expect((await json(en)).error.code).toBe("model_no_bindings");
    const ok = await h.admin("PATCH", `/models/${d.id}`, { enabled: true, bindings: bind }, { ifMatch: d.revision });
    expect(ok.status).toBe(200);
    const m = await json(ok);
    const clear = await h.admin("PUT", `/models/${m.id}/bindings`, { bindings: [] }, { ifMatch: m.revision });
    expect(clear.status).toBe(400);
    expect((await json(clear)).error.code).toBe("model_no_bindings");
    const rename = await h.admin("PATCH", `/models/${m.id}`, { name: "has space" }, { ifMatch: m.revision });
    expect((await json(rename)).error.code).toBe("invalid_model_name");
  });

  it("a stored name that breaks the rules still loads, with a startup warning", () => {
    const config = loadConfigFromObject({
      strategy: { mode: "single" },
      targets: [yamlTarget("a", ["up-a"])],
      models: [{ name: "bad name!", bindings: [{ target: "a", model: "up-a" }] }],
    });
    const gateway = new Gateway(config);
    expect(gateway.modelCatalog().lookup("bad name!")).toBeDefined();
    const warnings = publishedModelWarnings(gateway, config);
    expect(warnings.some((w) => w.includes("bad name!") && w.includes("invalid name"))).toBe(true);
  });
});

describe("U2: every admin error has a code", () => {
  it("logs and usage parameter errors", async () => {
    const h = await adminHarness(file(), { logStore: await RequestLogStore.create(new Database(":memory:")) });
    const cases: Array<[string, string, number, string]> = [
      ["DELETE", "/logs", 400, "missing_parameter"],
      ["DELETE", "/logs?before=garbage", 400, "invalid_parameter"],
      ["GET", "/usage?groupBy=nope", 400, "invalid_group_by"],
      ["GET", "/usage?tz=Mars/Base", 400, "invalid_timezone"],
      ["GET", "/usage?from=2026-11-05&to=2026-11-01", 400, "date_range_inverted"],
      ["GET", "/usage?from=2020-01-01&to=2026-11-01", 400, "date_range_too_long"],
      ["GET", "/usage?to=yesterday", 400, "invalid_date"],
      ["GET", "/usage?daily=maybe", 400, "invalid_parameter"],
      ["GET", "/keys/nope", 404, "key_not_found"],
      ["GET", "/nowhere", 404, "not_found"],
    ];
    for (const [method, path, status, code] of cases) {
      const r = await h.admin(method, path);
      expect([path, r.status]).toEqual([path, status]);
      const body = await json(r);
      expect([path, body.error.code]).toEqual([path, code]);
      expect(typeof body.error.message).toBe("string");
    }
  });
});
