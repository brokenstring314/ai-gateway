/** Contract: the admin console boots with the real server; an API key logs in and every page's data endpoints answer. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ADMIN_SECRET, baseConfig, postJson, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

describe("admin console", () => {
  let up: MockUpstream;
  let gw: GatewayProcess;
  let adminKey: string;
  let readOnlyKey: string;
  let inferenceKey: string;

  beforeAll(async () => {
    up = startMockUpstream("a");
    gw = await startGateway({
      config: baseConfig([
        {
          name: "a",
          mock: up,
          extra: { circuitBreaker: { failureThreshold: 5, successThreshold: 1, timeoutMs: 60_000 } },
        },
      ]),
    });
    await gw.client().chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    // Mint the console keys with the admin secret, as an operator would on first run.
    const asSecret = { auth: null, headers: { "X-Admin-Secret": ADMIN_SECRET } };
    const a = await postJson(gw, "/admin/keys", { name: "console-admin", scopes: ["admin"] }, asSecret);
    expect(a.status).toBe(201);
    adminKey = ((await a.json()) as { key: string }).key;
    const r = await postJson(gw, "/admin/keys", { name: "console-viewer", scopes: ["read_only"] }, asSecret);
    readOnlyKey = ((await r.json()) as { key: string }).key;
    const i = await postJson(gw, "/admin/keys", { name: "client", scopes: ["inference"] }, asSecret);
    inferenceKey = ((await i.json()) as { key: string }).key;
  });
  afterAll(async () => {
    await gw?.stop();
    up?.stop();
  });

  it("serves every page shell and asset without auth, with the strict CSP", async () => {
    for (const path of [
      "/admin/dashboard",
      "/admin/dashboard/keys",
      "/admin/dashboard/logs",
      "/admin/dashboard/config",
      "/admin/dashboard/login",
      "/admin/static/console.js",
      "/admin/static/console.css",
    ]) {
      const res = await gw.fetch(path, { auth: null });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      await res.arrayBuffer();
    }
    expect((await gw.fetch("/admin/dashboard/playground", { auth: null })).status).not.toBe(200);
  });

  it("login check: admin key -> 200 with admin scope; bad key -> 401; inference key -> 403", async () => {
    const ok = await gw.fetch("/admin/status", { auth: adminKey });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { scopes: string[] }).scopes).toContain("admin");
    expect((await gw.fetch("/admin/status", { auth: "sk-wrong" })).status).toBe(401);
    expect((await gw.fetch("/admin/status", { auth: inferenceKey })).status).toBe(403);
  });

  it("overview data: /readyz, /admin/status, /admin/logs/stats", async () => {
    const ready = (await (await gw.fetch("/readyz", { auth: null })).json()) as { status: string };
    expect(ready.status).toBe("ok");
    const status = (await (await gw.fetch("/admin/status", { auth: adminKey })).json()) as {
      circuitBreakers: Record<string, string>;
      upstreamAvailable: boolean;
      requests: { total: number; latencyMs: { p50: number | null } };
    };
    expect(status.upstreamAvailable).toBe(true);
    expect(status.circuitBreakers["a"]).toBe("CLOSED");
    expect(status.requests.total).toBeGreaterThan(0);
    expect(status.requests.latencyMs.p50).not.toBeNull();
    const stats = (await (await gw.fetch("/admin/logs/stats", { auth: adminKey })).json()) as { totalEntries: number };
    expect(stats.totalEntries).toBeGreaterThan(0);
  });

  it("keys page: list, create, rotate, revoke as admin; read_only lists only", async () => {
    const list = (await (await gw.fetch("/admin/keys", { auth: adminKey })).json()) as { total: number };
    expect(list.total).toBeGreaterThanOrEqual(3);
    const created = await postJson(
      gw,
      "/admin/keys",
      { name: "svc", scopes: ["inference"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      { auth: adminKey },
    );
    expect(created.status).toBe(201);
    const { id, key } = (await created.json()) as { id: string; key: string };
    expect(key.length).toBeGreaterThan(10);
    const rotated = await postJson(gw, `/admin/keys/${id}/rotate`, {}, { auth: adminKey });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { key: string }).key).not.toBe(key);
    expect((await postJson(gw, `/admin/keys/${id}/revoke`, {}, { auth: adminKey })).status).toBe(200);

    expect((await gw.fetch("/admin/keys", { auth: readOnlyKey })).status).toBe(200);
    expect((await postJson(gw, "/admin/keys", { name: "x" }, { auth: readOnlyKey })).status).toBe(403);
    expect((await postJson(gw, `/admin/keys/${id}/rotate`, {}, { auth: readOnlyKey })).status).toBe(403);
  });

  it("logs page: paginated and filterable", async () => {
    const page = (await (await gw.fetch("/admin/logs?limit=1&offset=0", { auth: readOnlyKey })).json()) as {
      entries: Array<{ stage: string; provider: string }>;
      total: number;
    };
    expect(page.entries.length).toBe(1);
    expect(page.total).toBeGreaterThan(0);
    const filtered = (await (
      await gw.fetch("/admin/logs?stage=chat&provider=a&model=gpt-4o&status=ok", { auth: readOnlyKey })
    ).json()) as { total: number };
    expect(filtered.total).toBeGreaterThan(0);
    const errors = (await (await gw.fetch("/admin/logs?status=error", { auth: readOnlyKey })).json()) as {
      total: number;
    };
    expect(errors.total).toBe(0);
  });

  it("config page: scrubbed config, no secrets", async () => {
    const res = await gw.fetch("/admin/config", { auth: readOnlyKey });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-upstream-a");
    expect(text).not.toContain(ADMIN_SECRET);
  });
});
