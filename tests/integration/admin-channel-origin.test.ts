/**
 * RC1 / RC2 (red team 2026-11-02) — fixed: an admin could PATCH a channel's
 * baseURL to any public host and then call /test, /fetch-models or /balance,
 * and the gateway sent the decrypted stored key (or the resolved value of an
 * env-referenced key) to that host. Now moving a channel to another origin
 * (scheme, host, port) requires its keys again in the same request
 * (`apiKeys`, which replaces every stored key), else 400
 * api_keys_required_on_base_url_change; the probes only ever use the saved
 * baseURL and keys; the change is audited.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { adminHarness, FakeUpstreams, type Harness, yamlTarget } from "./_admin-harness.js";

const up = new FakeUpstreams();
beforeAll(() => up.install());
afterAll(() => up.uninstall());
afterEach(() => up.reset());

const STORED = "sk-stored-secret-key-1111aaaa";
const NEW = "sk-new-origin-key-2222bbbb";

function file(extra: Record<string, unknown> = {}) {
  return {
    strategy: { mode: "fallback", targets: ["a"] },
    targets: [yamlTarget("a")],
    models: [{ name: "gpt-x", bindings: [{ target: "a" }] }],
    ...extra,
  };
}

async function json(r: Response): Promise<any> {
  return r.json();
}

async function channel(h: Harness, body: Record<string, unknown> = {}) {
  const r = await h.admin("POST", "/channels", {
    name: "c",
    preset: "openai",
    baseURL: "https://c.upstream.test/v1",
    keys: [{ key: STORED }],
    ...body,
  });
  expect(r.status).toBe(201);
  return json(r);
}

describe("RC1 base URL change needs the keys again", () => {
  it("PoC: PATCH baseURL to another host without apiKeys → 400, nothing changes, probes stay on the saved origin", async () => {
    const h = await adminHarness(file());
    const ch = await channel(h);
    const r = await h.admin(
      "PATCH",
      `/channels/${ch.id}`,
      { baseURL: "https://attacker.upstream.test/v1" },
      { ifMatch: ch.revision },
    );
    expect(r.status).toBe(400);
    const err = (await json(r)).error;
    expect(err.code).toBe("api_keys_required_on_base_url_change");
    expect(err.fields).toEqual([expect.objectContaining({ path: "apiKeys" })]);
    const now = await json(await h.admin("GET", `/channels/${ch.id}`));
    expect(now.baseURL).toBe("https://c.upstream.test/v1");
    expect(now.revision).toBe(ch.revision);
    await h.admin("POST", `/channels/${ch.id}/test`, {});
    await h.admin("POST", `/channels/${ch.id}/fetch-models`);
    expect(up.hits("attacker.upstream.test")).toHaveLength(0);
    expect(up.calls.every((c) => c.host === "c.upstream.test")).toBe(true);
  });

  it("an origin change via preset (baseURL cleared → preset default) is caught too", async () => {
    const h = await adminHarness(file());
    const ch = await channel(h);
    const r = await h.admin("PATCH", `/channels/${ch.id}`, { baseURL: null }, { ifMatch: ch.revision });
    expect(r.status).toBe(400);
    expect((await json(r)).error.code).toBe("api_keys_required_on_base_url_change");
  });

  it("same origin, other path: allowed without keys", async () => {
    const h = await adminHarness(file());
    const ch = await channel(h);
    const r = await h.admin(
      "PATCH",
      `/channels/${ch.id}`,
      { baseURL: "https://C.upstream.test:443/v2" },
      { ifMatch: ch.revision },
    );
    expect(r.status).toBe(200);
    expect((await json(r)).keys).toHaveLength(1);
  });

  it("with apiKeys: the keys are replaced, probes send only the new key to the new origin, audited", async () => {
    const h = await adminHarness(file());
    const ch = await channel(h);
    const r = await h.admin(
      "PATCH",
      `/channels/${ch.id}`,
      { baseURL: "https://d.upstream.test/v1", apiKeys: [{ key: NEW }] },
      { ifMatch: ch.revision },
    );
    expect(r.status).toBe(200);
    const after = await json(r);
    expect(after.keys.map((k: { hint: string }) => k.hint)).toEqual(["sk-…bbbb"]);
    expect(after.keys[0].id).not.toBe(ch.keys[0].id);
    expect((await json(await h.admin("POST", `/channels/${ch.id}/test`, {}))).ok).toBe(true);
    expect(up.calls.map((c) => `${c.host} ${c.auth}`)).toEqual([`d.upstream.test Bearer ${NEW}`]);
    const audit = (await json(await h.admin("GET", "/audit?limit=5"))).data;
    const entry = audit.find((a: { action: string }) => a.action === "update");
    expect(entry.detail.originChange).toEqual({ from: "https://c.upstream.test", to: "https://d.upstream.test" });
    expect(entry.detail.keysReplaced.removed).toEqual([{ id: ch.keys[0].id, hint: "sk-…aaaa" }]);
    expect(JSON.stringify(audit)).not.toContain(NEW);
    expect(JSON.stringify(audit)).not.toContain(STORED);
    // And the gateway serves through the new origin with the new key.
    expect((await h.chat("gpt-x")).status).toBe(200);
  });

  it("a channel without stored keys may move freely; apiKeys [] drops every key", async () => {
    const h = await adminHarness(file());
    const ch = await channel(h, { keys: [] });
    const r = await h.admin(
      "PATCH",
      `/channels/${ch.id}`,
      { baseURL: "https://e.upstream.test/v1" },
      { ifMatch: ch.revision },
    );
    expect(r.status).toBe(200);
    const ch2 = await channel(h, { name: "c2" });
    const dropped = await h.admin(
      "PATCH",
      `/channels/${ch2.id}`,
      { baseURL: "https://f.upstream.test/v1", apiKeys: [] },
      { ifMatch: ch2.revision },
    );
    expect(dropped.status).toBe(200);
    expect((await json(dropped)).keys).toEqual([]);
  });

  it("probe bodies cannot name a URL", async () => {
    const h = await adminHarness(file());
    const ch = await channel(h);
    const r = await h.admin("POST", `/channels/${ch.id}/test`, { baseURL: "https://attacker.upstream.test/v1" });
    expect(r.status).toBe(400);
    const fm = await h.admin("POST", `/channels/${ch.id}/fetch-models`, { url: "https://attacker.upstream.test" });
    expect(fm.status).toBe(400);
    expect(up.hits("attacker.upstream.test")).toHaveLength(0);
  });
});

describe("RC2 env-referenced keys", () => {
  it("a channel whose key is ${ENV} cannot be moved to another origin without new keys", async () => {
    process.env["RC2_UPSTREAM_ENV_KEY"] = "sk-ENVSECRET-zzzz9999";
    try {
      const h = await adminHarness(
        file({
          targets: [yamlTarget("a", ["gpt-x"], { apiKey: "${RC2_UPSTREAM_ENV_KEY}" })],
        }),
      );
      const list = (await json(await h.admin("GET", "/channels"))).data;
      const a = list.find((c: { name: string }) => c.name === "a");
      expect(a.keys[0].kind).toBe("env_ref");
      const r = await h.admin(
        "PATCH",
        `/channels/${a.id}`,
        { baseURL: "https://attacker.upstream.test/v1" },
        { ifMatch: a.revision },
      );
      expect(r.status).toBe(400);
      expect((await json(r)).error.code).toBe("api_keys_required_on_base_url_change");
      await h.admin("POST", `/channels/${a.id}/test`, {});
      expect(up.hits("attacker.upstream.test")).toHaveLength(0);
    } finally {
      delete process.env["RC2_UPSTREAM_ENV_KEY"];
    }
  });
});
