import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "@/app";
import { Gateway } from "@/gateway";
import { KeyStore } from "@/persistence/key-store";
import { RequestLogStore } from "@/persistence/request-log-store";
import { Metrics, resetMetrics } from "@/metrics/metrics";
import type { GatewayConfig } from "@/config/types";

function makeConfig(): GatewayConfig {
  return {
    strategy: { mode: "fallback", targets: ["a", "b"] },
    targets: [
      { name: "a", provider: "openai", apiKey: "sk-a", baseURL: "https://a.example/v1", models: ["gpt-4o"] },
      { name: "b", provider: "openai", apiKey: "sk-b", baseURL: "https://b.example/v1", models: ["gpt-4o"] },
    ],
    adminSecret: "test-admin-secret-1234",
  };
}

async function makeApp() {
  const config = makeConfig();
  const keyStore = await KeyStore.create(new Database(":memory:"));
  const logStore = await RequestLogStore.create(new Database(":memory:"));
  const app = createApp(new Gateway(config), config, undefined, keyStore, {
    logStore,
    adminSecret: config.adminSecret,
  });
  return { app, keyStore, logStore };
}

afterEach(() => resetMetrics());

describe("GET /admin/status", () => {
  it("rejects anonymous and inference-only callers", async () => {
    const { app, keyStore } = await makeApp();
    expect((await app.request("/admin/status")).status).toBe(401);
    const inf = keyStore.create("client", ["inference"]).key;
    expect((await app.request("/admin/status", { headers: { Authorization: `Bearer ${inf}` } })).status).toBe(403);
  });

  it("returns scopes, breakers per target, upstreamAvailable, MCP states and a request summary", async () => {
    const { app, keyStore } = await makeApp();
    keyStore.create("admin", ["admin"]);
    const ro = keyStore.create("viewer", ["read_only"]).key;
    const res = await app.request("/admin/status", { headers: { Authorization: `Bearer ${ro}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scopes: string[];
      version: string;
      providers: number;
      upstreamAvailable: boolean;
      circuitBreakers: Record<string, string>;
      mcpServers: Record<string, string>;
      requests: { total: number; errorRate: number; latencyMs: { p50: number | null } };
    };
    expect(body.scopes).toEqual(["read_only"]);
    expect(body.version).toBe("0.2.0");
    expect(body.providers).toBe(2);
    expect(body.upstreamAvailable).toBe(true);
    expect(typeof body.circuitBreakers).toBe("object");
    expect(body.mcpServers).toEqual({});
    expect(typeof body.requests.total).toBe("number");
    expect(body.requests).toHaveProperty("latencyMs");
  });

  it("admin secret is reported as admin scope", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/status", { headers: { "X-Admin-Secret": "test-admin-secret-1234" } });
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(["admin"]);
  });
});

describe("GET /admin/keys for read_only", () => {
  it("read_only can list (no plaintext) but not create, revoke or rotate", async () => {
    const { app, keyStore } = await makeApp();
    const target = keyStore.create("admin", ["admin"]);
    const ro = keyStore.create("viewer", ["read_only"]).key;
    const h = { Authorization: `Bearer ${ro}` };
    const list = await app.request("/admin/keys", { headers: h });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys.length).toBe(2);
    for (const k of body.keys) expect(k["key"]).toBeUndefined();
    const post = (path: string, json?: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { ...h, "Content-Type": "application/json" },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
    expect((await post("/admin/keys", { name: "x" })).status).toBe(403);
    expect((await post(`/admin/keys/${target.id}/revoke`)).status).toBe(403);
    expect((await post(`/admin/keys/${target.id}/rotate`)).status).toBe(403);
  });
});

describe("GET /admin/logs status filter", () => {
  it("status=error / status=ok split entries; stats honor it", async () => {
    const { app, logStore } = await makeApp();
    const base = {
      model: "gpt-4o",
      provider: "a",
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      createdAt: new Date(),
    };
    logStore.write({ ...base, traceId: "t1", stage: "chat", errorMessage: "" });
    logStore.write({ ...base, traceId: "t2", stage: "chat", errorMessage: "upstream 500" });
    logStore.write({ ...base, traceId: "t3", stage: "embedding", errorMessage: "" });
    const h = { "X-Admin-Secret": "test-admin-secret-1234" };
    const get = async (q: string) =>
      (await (await app.request(`/admin/logs${q}`, { headers: h })).json()) as {
        total: number;
        entries: Array<{ traceId: string }>;
      };
    expect((await get("")).total).toBe(3);
    const errs = await get("?status=error");
    expect(errs.total).toBe(1);
    expect(errs.entries[0]?.traceId).toBe("t2");
    expect((await get("?status=ok")).total).toBe(2);
    expect((await get("?status=ok&stage=embedding")).total).toBe(1);
    expect((await get("?status=bogus")).total).toBe(3);
    const stats = (await (await app.request("/admin/logs/stats?status=error", { headers: h })).json()) as {
      totalEntries: number;
    };
    expect(stats.totalEntries).toBe(1);
  });
});

describe("Metrics.requestSummary", () => {
  it("counts only upstream-served requests and computes error rate and latency", async () => {
    const m = new Metrics();
    for (let i = 0; i < 9; i++) {
      m.recordRequest({ method: "POST", status: 200, provider: "a" });
      m.observeDuration(0.08, { method: "POST", status: 200, provider: "a" });
    }
    m.recordRequest({ method: "POST", status: 502, provider: "b" });
    m.observeDuration(2, { method: "POST", status: 502, provider: "b" });
    m.recordRequest({ method: "GET", status: 401, provider: "unknown" }); // admin/console traffic
    const s = await m.requestSummary();
    expect(s.total).toBe(10);
    expect(s.serverErrors).toBe(1);
    expect(s.clientErrors).toBe(0);
    expect(s.errorRate).toBeCloseTo(0.1);
    expect(s.latencyMs.mean).toBe(272);
    expect(s.latencyMs.p50).toBe(100); // 0.1 s bucket bound
    expect(s.latencyMs.p95).toBe(2500);
  });

  it("returns nulls without samples", async () => {
    const s = await new Metrics().requestSummary();
    expect(s).toEqual({
      total: 0,
      clientErrors: 0,
      serverErrors: 0,
      errorRate: 0,
      latencyMs: { mean: null, p50: null, p95: null },
    });
  });
});
