import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { ConfigStore } from "@/persistence/config-store";
import {
  getConfigHandler,
  putConfigHandler,
  reloadConfigHandler,
  deleteConfigHandler,
  getConfigHistoryHandler,
  rollbackConfigHandler,
  type ConfigHandlerState,
} from "@/admin/config-handlers";
import { GatewayConfigSchema } from "@/config/schema";
import type { GatewayConfig } from "@/config/types";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    apiVersion: "v1",
    strategy: { mode: "fallback", targets: ["primary"] },
    targets: [{ name: "primary", provider: "openai", apiKey: "sk-secret-a" }],
    server: { port: 3000, host: "0.0.0.0" },
    ...overrides,
  };
}

function createApp(state: ConfigHandlerState): Hono {
  const app = new Hono();
  app.get("/config", getConfigHandler(state));
  app.put("/config", putConfigHandler(state));
  app.post("/config/reload", reloadConfigHandler(state));
  app.delete("/config", deleteConfigHandler(state));
  app.get("/config/history", getConfigHistoryHandler(state));
  app.post("/config/rollback/:version", rollbackConfigHandler(state));
  return app;
}

function putConfig(app: Hono, config: GatewayConfig): Promise<Response> {
  return app.request("/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

interface HistoryVersion {
  version: number;
  configJson: string;
  updatedAt: string;
}

interface HistoryResponse {
  versions: HistoryVersion[];
  total: number;
}

describe("Admin config handlers (ConfigStore-backed)", () => {
  let db: Database;
  let store: ConfigStore;
  let state: ConfigHandlerState;
  let app: Hono;

  beforeEach(async () => {
    db = new Database(":memory:");
    store = await ConfigStore.create(db);
    state = { configStore: store, currentConfig: makeConfig() };
    app = createApp(state);
  });

  afterEach(() => {
    db.close();
  });

  it("PUT /config saves and appends one history entry", async () => {
    const body = makeConfig({
      targets: [{ name: "primary", provider: "openai", apiKey: "sk-new" }],
    });
    const res = await putConfig(app, body);
    expect(res.status).toBe(200);

    const history = store.loadHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.version).toBe(1);
    expect(store.load()).toBe(JSON.stringify(GatewayConfigSchema.parse(body)));
  });

  it("PUT /config twice appends two history entries", async () => {
    await putConfig(app, makeConfig({ targets: [{ name: "a", provider: "openai", apiKey: "sk-1" }] }));
    await putConfig(app, makeConfig({ targets: [{ name: "b", provider: "openai", apiKey: "sk-2" }] }));

    const history = store.loadHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.version).toBe(1);
    expect(history[1]!.version).toBe(2);
    expect(store.load()!).toContain("sk-2");
  });

  it("GET /config/history returns version, configJson and updatedAt", async () => {
    await putConfig(app, makeConfig({ targets: [{ name: "primary", provider: "openai", apiKey: "sk-1" }] }));

    const res = await app.request("/config/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryResponse;
    expect(body.total).toBe(1);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]!.version).toBe(1);
    expect(typeof body.versions[0]!.configJson).toBe("string");
    expect(body.versions[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const parsed = JSON.parse(body.versions[0]!.configJson) as {
      targets: { name: string; apiKey: string }[];
    };
    expect(parsed.targets[0]!.name).toBe("primary");
    expect(parsed.targets[0]!.apiKey).toBe("***");
  });

  it("GET /config/history is scrubbed (no plaintext apiKey)", async () => {
    await putConfig(
      app,
      makeConfig({ targets: [{ name: "primary", provider: "openai", apiKey: "sk-super-secret-value" }] }),
    );

    const body = (await (await app.request("/config/history")).json()) as HistoryResponse;
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("sk-super-secret-value");
    expect(raw).toContain("***");
  });

  it("POST /config/rollback/:version restores an old version as the new current", async () => {
    await putConfig(app, makeConfig({ targets: [{ name: "primary", provider: "openai", apiKey: "sk-v1" }] }));
    await putConfig(app, makeConfig({ targets: [{ name: "backup", provider: "anthropic", apiKey: "sk-v2" }] }));

    const res = await app.request("/config/rollback/1", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: GatewayConfig };
    expect(body.config.targets[0]!.name).toBe("primary");
    expect(body.config.targets[0]!.provider).toBe("openai");
    expect(body.config.targets[0]!.apiKey).toBe("***");

    expect(store.load()!).toContain("sk-v1");
    const history = store.loadHistory();
    expect(history).toHaveLength(3);
    expect(history[2]!.version).toBe(3);
    expect(JSON.parse(history[2]!.configJson) as { targets: { name: string }[] }).toMatchObject({
      targets: [{ name: "primary" }],
    });

    const getBody = (await (await app.request("/config")).json()) as { config: GatewayConfig };
    expect(getBody.config.targets[0]!.name).toBe("primary");
  });

  it("POST /config/rollback/:version with unknown version returns 404", async () => {
    await putConfig(app, makeConfig());

    const res = await app.request("/config/rollback/99", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /config/rollback/:version with non-numeric version returns 404", async () => {
    await putConfig(app, makeConfig());

    const res = await app.request("/config/rollback/abc", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("DELETE /config clears the persisted config", async () => {
    await putConfig(app, makeConfig());

    const res = await app.request("/config", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(store.load()).toBeNull();
  });

  it("no store → DELETE /config returns deleted: true", async () => {
    const emptyApp = createApp({ configStore: null, currentConfig: makeConfig() });

    const res = await emptyApp.request("/config", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  it("no store → GET /config/history returns empty versions", async () => {
    const emptyApp = createApp({ configStore: null, currentConfig: makeConfig() });

    const body = (await (await emptyApp.request("/config/history")).json()) as HistoryResponse;
    expect(body.total).toBe(0);
    expect(body.versions).toEqual([]);
  });

  it("GET /config/history honors limit and offset pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await putConfig(
        app,
        makeConfig({ targets: [{ name: `t${i}`, provider: "openai", apiKey: `sk-${i}` }] }),
      );
    }

    const body = (await (await app.request("/config/history?limit=2&offset=1")).json()) as HistoryResponse;
    expect(body.total).toBe(5);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]!.version).toBe(2);
    expect(body.versions[1]!.version).toBe(3);
  });

  it("GET /config returns the scrubbed current config", async () => {
    await putConfig(
      app,
      makeConfig({ targets: [{ name: "new-name", provider: "anthropic", apiKey: "sk-leaked" }] }),
    );

    const body = (await (await app.request("/config")).json()) as { config: GatewayConfig };
    expect(body.config.targets[0]!.name).toBe("new-name");
    expect(body.config.targets[0]!.provider).toBe("anthropic");
    expect(body.config.targets[0]!.apiKey).toBe("***");
  });

  it("PUT /config with invalid body returns 400", async () => {
    const res = await app.request("/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: { mode: "bogus" }, targets: [] }),
    });
    expect(res.status).toBe(400);
  });
});
