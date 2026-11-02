/**
 * Review 2026-11-02:
 *  - U2: a key restricted to NO models (allowedModels: []) must stay so when
 *    another field is edited; [] (none), null (all) and an omitted field
 *    (unchanged) are three different things on PATCH /admin/keys/:id.
 *  - U5: PATCH /admin/models/:id accepts `bindings` and applies the fields and
 *    the bindings in one transaction (one config version, all or nothing), so
 *    the console's model drawer never leaves a half-applied save.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { adminHarness, FakeUpstreams, yamlTarget } from "./_admin-harness.js";

const up = new FakeUpstreams();
beforeAll(() => up.install());
afterAll(() => up.uninstall());
afterEach(() => up.reset());

function explicitFile() {
  return {
    strategy: { mode: "fallback", targets: ["a", "b"] },
    targets: [yamlTarget("a"), yamlTarget("b")],
    models: [{ name: "gpt-x", bindings: [{ target: "a" }] }],
  };
}

async function json(r: Response): Promise<any> {
  return r.json();
}

describe("U2 PATCH /admin/keys/:id allowedModels: [] vs null vs omitted", () => {
  it("[] round-trips as [] (none); null widens to all; omitted leaves it alone", async () => {
    const h = await adminHarness(explicitFile());
    const created = await json(await h.admin("POST", "/keys", { name: "none", allowedModels: [] }));
    expect(created.allowedModels).toEqual([]);

    // Unrelated edit: allowedModels omitted → unchanged.
    let r = await h.admin("PATCH", `/keys/${created.id}`, { quotaTokens: 1000 }, { ifMatch: created.revision });
    expect(r.status).toBe(200);
    let k = await json(r);
    expect(k.allowedModels).toEqual([]);
    expect(k.quotaTokens).toBe(1000);

    // The console sends the whole form: [] stays [].
    r = await h.admin(
      "PATCH",
      `/keys/${created.id}`,
      { name: "none", allowedModels: [], quotaTokens: 2000, rpm: null, tpm: null, expiresAt: null },
      { ifMatch: k.revision },
    );
    k = await json(r);
    expect(k.allowedModels).toEqual([]);

    // A key with no model allowed cannot call any model.
    expect((await h.chat("gpt-x", { key: created.key })).status).toBe(403);

    // null = every model.
    r = await h.admin("PATCH", `/keys/${created.id}`, { allowedModels: null }, { ifMatch: k.revision });
    expect((await json(r)).allowedModels).toBeNull();
  });
});

describe("U5 PATCH /admin/models/:id with bindings is atomic", () => {
  it("fields + bindings in one write: one version, one revision step", async () => {
    const h = await adminHarness(explicitFile());
    const chs = await json(await h.admin("GET", "/channels"));
    const b = chs.data.find((c: { name: string }) => c.name === "b");
    const m = (await json(await h.admin("GET", "/models"))).data.find((x: { name: string }) => x.name === "gpt-x");
    const head0 = (await json(await h.admin("GET", "/config/versions?limit=1"))).head;
    const r = await h.admin(
      "PATCH",
      `/models/${m.id}`,
      { description: "both at once", bindings: [{ channelId: b.id, upstreamModel: "up-b" }] },
      { ifMatch: m.revision },
    );
    expect(r.status).toBe(200);
    const after = await json(r);
    expect(after.description).toBe("both at once");
    expect(
      after.bindings.map((x: { channelId: string; upstreamModel: string }) => [x.channelId, x.upstreamModel]),
    ).toEqual([[b.id, "up-b"]]);
    expect((await json(await h.admin("GET", "/config/versions?limit=1"))).head).toBe(head0 + 1);
    expect((await h.chat("gpt-x")).status).toBe(200);
    expect(up.hits("b.upstream.test").map((c) => c.body.model)).toEqual(["up-b"]);
  });

  it("a rejected binding leaves the fields unchanged too (no half-applied save), and the same revision still works", async () => {
    const h = await adminHarness(explicitFile());
    const chs = await json(await h.admin("GET", "/channels"));
    const a = chs.data.find((c: { name: string }) => c.name === "a");
    const m = (await json(await h.admin("GET", "/models"))).data.find((x: { name: string }) => x.name === "gpt-x");
    const head0 = (await json(await h.admin("GET", "/config/versions?limit=1"))).head;

    // Fails inside the transaction (same channel twice), after the field update ran.
    const bad = await h.admin(
      "PATCH",
      `/models/${m.id}`,
      { description: "half applied?", bindings: [{ channelId: a.id }, { channelId: a.id }] },
      { ifMatch: m.revision },
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    // Fails schema validation (upstream model name too long).
    const bad2 = await h.admin(
      "PATCH",
      `/models/${m.id}`,
      { description: "half applied?", bindings: [{ channelId: a.id, upstreamModel: "x".repeat(201) }] },
      { ifMatch: m.revision },
    );
    expect(bad2.status).toBe(400);

    const now = await json(await h.admin("GET", `/models/${m.id}`));
    expect(now.description ?? null).toBeNull();
    expect(now.revision).toBe(m.revision);
    expect((await json(await h.admin("GET", "/config/versions?limit=1"))).head).toBe(head0);

    // Retrying with the fixed binding and the same If-Match succeeds (no 409 from a half-save).
    const ok = await h.admin(
      "PATCH",
      `/models/${m.id}`,
      { description: "saved", bindings: [{ channelId: a.id, upstreamModel: "up-a" }] },
      { ifMatch: m.revision },
    );
    expect(ok.status).toBe(200);
    expect((await json(ok)).description).toBe("saved");
  });
});
