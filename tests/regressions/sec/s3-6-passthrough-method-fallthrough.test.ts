// S3-6: with passthroughProxy.enabled, any method other than the one a gateway
// handler is registered for (e.g. GET/DELETE /v1/chat/completions[/<id>],
// GET /v1/files, GET /v1/responses/<id>) falls through to the catch-all proxy
// and is forwarded with the OPERATOR's upstream key. Every tenant therefore
// shares — and can list/read/delete — the operator account's stored chat
// completions, files, responses, batches... of every other tenant.
// Also: before-request plugins only see model+messages, so max-token is not
// applied to proxied bodies (max_output_tokens / max_tokens pass unchanged).
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { cfg, memKeyStore, okChat } from "./_h";

let calls: { method: string; url: string; auth: string | null; body?: string }[] = [];
let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  calls = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (u: string, init: RequestInit) => {
    calls.push({
      method: String(init?.method),
      url: String(u),
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined,
    });
    return okChat();
  }) as unknown as typeof fetch);
});
afterEach(() => fetchSpy.mockRestore());

async function setup() {
  const ks = await memKeyStore();
  const tenantB = ks.create("tenant-b", ["inference"]).key;
  const config = cfg({
    passthroughProxy: { enabled: true },
    plugins: [{ name: "max-token", config: { maxTokens: 10 } }],
  });
  return { app: createApp(new Gateway(config), config, undefined, ks), tenantB };
}

describe("S3-6 pass-through exposes shared upstream state", () => {
  it("GET /v1/chat/completions (list stored completions) must not be proxied with the operator key", async () => {
    const { app, tenantB } = await setup();
    const r = await app.request("/v1/chat/completions?limit=100", {
      method: "GET",
      headers: { authorization: `Bearer ${tenantB}`, "x-provider": "t" },
    });
    expect(
      calls.filter(
        (c) => c.method === "GET" && c.url.includes("/v1/chat/completions") && c.auth === "Bearer sk-OPERATOR-SECRET",
      ),
    ).toEqual([]); // FAILS
    expect(r.status).not.toBe(200);
  });
  it("DELETE /v1/files/<other tenant's file> must not be proxied with the operator key", async () => {
    const { app, tenantB } = await setup();
    await app.request("/v1/files/file-of-tenant-a", {
      method: "DELETE",
      headers: { authorization: `Bearer ${tenantB}`, "x-provider": "t" },
    });
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]); // FAILS
  });
  it("max-token cap must apply to proxied /v1/responses bodies", async () => {
    const { app, tenantB } = await setup();
    await app.request("/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${tenantB}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hi", max_output_tokens: 100000 }),
    });
    const sent = calls.find((c) => c.url.endsWith("/v1/responses"));
    expect(sent?.body ?? "").not.toContain("100000"); // FAILS: forwarded uncapped
  });
});
