/**
 * 0.3.0 P2: per-model routing, strict published-model check, per-key model
 * allow-lists and the filtered /v1/models.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../../src/app.js";
import { loadConfigFromObject } from "../../src/config/loader.js";
import { composeConfig } from "../../src/config/runtime-source.js";
import { Gateway } from "../../src/gateway.js";
import { ConfigStore } from "../../src/persistence/config-store.js";
import { KeyStore } from "../../src/persistence/key-store.js";
import type { ChatCompletionRequest, RequestContext } from "../../src/providers/types.js";
import { SecretBox } from "../../src/secrets/secret-box.js";

type Hit = { target: string; model: string; path: string };
const hits: Hit[] = [];
const failing = new Set<string>();

const up = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const target = url.pathname.split("/")[1] ?? "";
    const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean };
    hits.push({ target, model: body.model ?? "", path: url.pathname });
    if (failing.has(target)) return Response.json({ error: { message: "down" } }, { status: 500 });
    if (url.pathname.endsWith("/embeddings")) {
      return Response.json({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1] }],
        model: body.model,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }
    if (body.stream) {
      const chunk = (content: string) =>
        `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
      return new Response(`${chunk(`${target}:${body.model}`)}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        { index: 0, message: { role: "assistant", content: `${target}:${body.model}` }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});

let savedNoProxy: string | undefined;
beforeAll(() => {
  savedNoProxy = process.env["NO_PROXY"];
  process.env["NO_PROXY"] = "127.0.0.1,localhost";
});
afterAll(() => {
  up.stop(true);
  if (savedNoProxy === undefined) delete process.env["NO_PROXY"];
  else process.env["NO_PROXY"] = savedNoProxy;
});
beforeEach(() => {
  hits.length = 0;
  failing.clear();
});

const target = (name: string, models?: string[]) => ({
  name,
  provider: "openai",
  apiKey: `sk-${name}`,
  baseURL: `http://127.0.0.1:${up.port}/${name}/v1`,
  ...(models ? { models } : {}),
});

function explicitConfig(extra: Record<string, unknown> = {}) {
  return loadConfigFromObject({
    strategy: { mode: "fallback", targets: ["A", "B"] },
    targets: [target("A"), target("B")],
    models: [
      {
        name: "my-chat",
        displayName: "My Chat",
        metadata: { contextWindow: 64000, tools: true },
        bindings: [
          { target: "A", model: "deepseek-chat" },
          { target: "B", model: "relay-deepseek-chat" },
        ],
      },
      { name: "gpt-4o", bindings: [{ target: "B" }] },
      { name: "off", enabled: false, bindings: [{ target: "A" }] },
      {
        name: "lb",
        strategy: "loadbalance",
        bindings: [
          { target: "A", weight: 0 },
          { target: "B", weight: 3 },
        ],
      },
      { name: "emb", bindings: [{ target: "A", model: "text-embedding-3-small" }] },
    ],
    aliases: { fast: "my-chat" },
    ...extra,
  });
}

const ctx = (): RequestContext => ({ metadata: {} });
const chat = (model: string): ChatCompletionRequest => ({ model, messages: [{ role: "user", content: "hi" }] });

describe("explicit published models", () => {
  it("routes only to the model's bindings, renaming the model per binding", async () => {
    const g = new Gateway(explicitConfig());
    const r = await g.route(ctx(), chat("my-chat"));
    expect(r.choices[0]?.message?.content).toBe("A:deepseek-chat");
    expect(hits).toEqual([{ target: "A", model: "deepseek-chat", path: "/A/v1/chat/completions" }]);
  });

  it("fails over to the next binding with that binding's upstream name", async () => {
    failing.add("A");
    const g = new Gateway(explicitConfig());
    const r = await g.route(ctx(), chat("my-chat"));
    expect(r.choices[0]?.message?.content).toBe("B:relay-deepseek-chat");
    expect(hits.map((h) => `${h.target}:${h.model}`)).toEqual(["A:deepseek-chat", "B:relay-deepseek-chat"]);
  });

  it("a model bound only to B never touches A (even when the global strategy starts with A)", async () => {
    const g = new Gateway(explicitConfig());
    const r = await g.route(ctx(), chat("gpt-4o"));
    expect(r.choices[0]?.message?.content).toBe("B:gpt-4o");
    expect(hits.map((h) => h.target)).toEqual(["B"]);
  });

  it("aliases resolve to the published model", async () => {
    const g = new Gateway(explicitConfig());
    const r = await g.route(ctx(), chat("fast"));
    expect(r.choices[0]?.message?.content).toBe("A:deepseek-chat");
  });

  it("rejects an unpublished model with 404 model_not_found and a reason, without calling upstream", async () => {
    const g = new Gateway(explicitConfig());
    const err = await g.route(ctx(), chat("deepseek-chat")).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe("model_not_found");
    expect(err.message).toContain("not a published model or alias");
    expect(err.message).toContain("/v1/models");
    expect(hits).toEqual([]);
  });

  it("rejects a disabled model", async () => {
    const g = new Gateway(explicitConfig());
    const err = await g.route(ctx(), chat("off")).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.message).toContain("disabled");
    expect(hits).toEqual([]);
  });

  it("loadbalance never picks a weight-0 binding", async () => {
    const g = new Gateway(explicitConfig());
    for (let i = 0; i < 20; i++) await g.route(ctx(), chat("lb"));
    expect(new Set(hits.map((h) => h.target))).toEqual(new Set(["B"]));
  });

  it("streams with the per-binding upstream name", async () => {
    const g = new Gateway(explicitConfig());
    let text = "";
    for await (const c of g.routeStream(ctx(), chat("my-chat"))) text += c.choices[0]?.delta?.content ?? "";
    expect(text).toBe("A:deepseek-chat");
    const err = await (async () => {
      for await (const _ of g.routeStream(ctx(), chat("nope"))) {
        /* drain */
      }
    })().catch((e) => e);
    expect(err.status).toBe(404);
  });

  it("embeddings use the bindings too", async () => {
    const g = new Gateway(explicitConfig());
    await g.embed(ctx(), { model: "emb", input: "x" });
    expect(hits).toEqual([{ target: "A", model: "text-embedding-3-small", path: "/A/v1/embeddings" }]);
    const err = await g.embed(ctx(), { model: "text-embedding-3-small", input: "x" }).catch((e) => e);
    expect(err.status).toBe(404);
  });
});

describe("implicit published models (targets[].models)", () => {
  const cfg = () =>
    loadConfigFromObject({
      strategy: { mode: "fallback", targets: ["A", "B"] },
      targets: [target("A", ["x"]), target("B", ["y", "x"])],
    });

  it("only targets that list the model get it, in the global strategy's order", async () => {
    const g = new Gateway(cfg());
    await g.route(ctx(), chat("y"));
    expect(hits.map((h) => h.target)).toEqual(["B"]);
    hits.length = 0;
    failing.add("A");
    await g.route(ctx(), chat("x"));
    expect(hits.map((h) => h.target)).toEqual(["A", "B"]);
  });

  it("a model no target lists is rejected", async () => {
    const g = new Gateway(cfg());
    const err = await g.route(ctx(), chat("z")).catch((e) => e);
    expect(err.status).toBe(404);
    expect(hits).toEqual([]);
  });
});

describe("config validation", () => {
  const base = { strategy: { mode: "single", targets: ["A"] }, targets: [target("A")] };
  it("rejects unknown targets, double bindings, aliases to unpublished models", () => {
    expect(() => loadConfigFromObject({ ...base, models: [{ name: "m", bindings: [{ target: "Z" }] }] })).toThrow(
      /unknown target "Z"/,
    );
    expect(() =>
      loadConfigFromObject({ ...base, models: [{ name: "m", bindings: [{ target: "A" }, { target: "A" }] }] }),
    ).toThrow(/twice/);
    expect(() =>
      loadConfigFromObject({ ...base, models: [{ name: "m", bindings: [{ target: "A" }] }], aliases: { a: "nope" } }),
    ).toThrow(/not a published model/);
    expect(() =>
      loadConfigFromObject({ ...base, models: [{ name: "m", bindings: [{ target: "A" }] }], aliases: { m: "m" } }),
    ).toThrow(/also an alias/);
  });
});

describe("config store keeps published models", () => {
  it("imports and loads models with bindings (normalized)", async () => {
    const file = explicitConfig();
    const store = await ConfigStore.create(new Database(":memory:"), await SecretBox.create(new Uint8Array(32)));
    await store.importFromConfig(file);
    const composed = composeConfig(file, await store.loadRuntimeSections());
    expect(composed.models).toEqual(file.models);
    const g = new Gateway(composed);
    expect((await g.route(ctx(), chat("my-chat"))).choices[0]?.message?.content).toBe("A:deepseek-chat");
  });

  it("an implicit config stays implicit", async () => {
    const file = loadConfigFromObject({ strategy: { mode: "single", targets: ["A"] }, targets: [target("A", ["x"])] });
    const store = await ConfigStore.create(new Database(":memory:"), await SecretBox.create(new Uint8Array(32)));
    await store.importFromConfig(file);
    expect(composeConfig(file, await store.loadRuntimeSections()).models).toBeUndefined();
  });
});

describe("per-key allowed models over HTTP", () => {
  async function setup() {
    const config = explicitConfig({ auth: { enabled: true }, adminSecret: "admin-secret-0123456789" });
    const store = await KeyStore.create(new Database(":memory:"));
    const open = store.create("open", ["inference"]).key;
    const limited = store.create("limited", ["inference"], undefined, { allowedModels: ["my-chat"] }).key;
    const app = createApp(new Gateway(config), config, undefined, store);
    const call = (key: string, path: string, body?: unknown) =>
      app.request(path, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    return { store, open, limited, call, app };
  }

  it("a restricted key may use its models (and their aliases) only; others get 403 with the reason", async () => {
    const { limited, call } = await setup();
    expect((await call(limited, "/v1/chat/completions", chat("my-chat"))).status).toBe(200);
    expect((await call(limited, "/v1/chat/completions", chat("fast"))).status).toBe(200);
    const denied = await call(limited, "/v1/chat/completions", chat("gpt-4o"));
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_allowed");
    expect(body.error.message).toContain('not allowed to use the model "gpt-4o"');
    // Unknown names get the same 403: nothing leaks about models outside the list.
    expect((await call(limited, "/v1/chat/completions", chat("secret-model"))).status).toBe(403);
    const stream = await call(limited, "/v1/chat/completions", { ...chat("gpt-4o"), stream: true });
    expect(stream.status).toBe(403);
    expect(hits.every((h) => h.model === "deepseek-chat")).toBe(true);
  });

  it("an unrestricted key gets 404 with the reason for an unpublished model", async () => {
    const { open, call } = await setup();
    const r = await call(open, "/v1/chat/completions", chat("deepseek-chat"));
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("model_not_found");
  });

  it("/v1/models lists what the key may use, with metadata; disabled models hidden", async () => {
    const { open, limited, call } = await setup();
    const all = (await (await call(open, "/v1/models")).json()) as { data: Array<Record<string, unknown>> };
    expect(all.data.map((m) => m["id"])).toEqual(["my-chat", "gpt-4o", "lb", "emb", "fast"]);
    expect(all.data[0]).toMatchObject({
      id: "my-chat",
      object: "model",
      display_name: "My Chat",
      metadata: { contextWindow: 64000, tools: true },
    });
    expect(all.data.find((m) => m["id"] === "fast")).toMatchObject({ alias_of: "my-chat" });
    const mine = (await (await call(limited, "/v1/models")).json()) as { data: Array<Record<string, unknown>> };
    expect(mine.data.map((m) => m["id"])).toEqual(["my-chat", "fast"]);
  });

  it("admin API sets and clears a key's allowed models", async () => {
    const { store, app } = await setup();
    const admin = { authorization: "Bearer admin-secret-0123456789", "content-type": "application/json" };
    const created = await app.request("/admin/keys", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: "k", allowedModels: ["gpt-4o", "gpt-4o"] }),
    });
    expect(created.status).toBe(201);
    const c = (await created.json()) as { id: string; allowedModels: string[] };
    expect(c.allowedModels).toEqual(["gpt-4o"]);
    const bad = await app.request("/admin/keys", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: "k", allowedModels: "gpt-4o" }),
    });
    expect(bad.status).toBe(400);
    const cleared = await app.request(`/admin/keys/${c.id}`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ allowedModels: null }),
    });
    expect(cleared.status).toBe(200);
    expect(store.get(c.id)?.allowedModels).toBeNull();
  });
});

describe("pass-through proxy respects published models and key restrictions", () => {
  async function setup() {
    const config = explicitConfig({
      auth: { enabled: true },
      passthroughProxy: { enabled: true },
    });
    const store = await KeyStore.create(new Database(":memory:"));
    const open = store.create("open", ["inference"]).key;
    const limited = store.create("limited", ["inference"], undefined, { allowedModels: ["my-chat"] }).key;
    const app = createApp(new Gateway(config), config, undefined, store);
    const post = (key: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request("/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    return { open, limited, post };
  }

  it("enforces allow-lists, published names and X-Provider bindings", async () => {
    const { open, limited, post } = await setup();
    expect((await post(limited, { model: "gpt-4o", input: "hi" })).status).toBe(403);
    expect((await post(limited, { input: "hi" })).status).toBe(403);
    expect((await post(open, { model: "nope", input: "hi" })).status).toBe(404);
    const unbound = await post(open, { model: "gpt-4o", input: "hi" }, { "X-Provider": "A" });
    expect(unbound.status).toBe(400);
    expect(((await unbound.json()) as { error: { code: string } }).error.code).toBe("provider_not_bound");
    expect(hits).toEqual([]);
    expect((await post(open, { model: "gpt-4o", input: "hi" })).status).toBe(200);
    expect(hits.map((h) => h.path)).toEqual(["/B/v1/responses"]);
  });
});
