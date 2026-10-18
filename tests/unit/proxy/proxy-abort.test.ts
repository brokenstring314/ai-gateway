// Regression: the pass-through proxy answered a gateway request timeout with
// a generic 502 upstream_error, and reported a client disconnect as an
// upstream failure (502) — or, behind the timeout middleware, did not abort
// the upstream fetch on client disconnect at all.
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createProxyHandler, type ProxyTarget } from "@/proxy/proxy";
import { createTimeoutReason } from "@/routing/outcome";

const target: ProxyTarget = {
  name: "t", provider: "openai", baseURL: "https://up.example", apiKey: "k",
  authHeaders: { Authorization: "Bearer k" },
};

/** fetch stand-in that hangs until its signal aborts, then rejects like fetch. */
function hangingFetch(): { fetchImpl: typeof fetch; started: Promise<void> } {
  let markStarted!: () => void;
  const started = new Promise<void>((r) => { markStarted = r; });
  const fetchImpl = ((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
    markStarted();
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(
      signal.reason instanceof DOMException ? signal.reason : new DOMException("aborted", "AbortError"),
    ), { once: true });
  })) as unknown as typeof fetch;
  return { fetchImpl, started };
}

function mount(fetchImpl: typeof fetch, withTimeoutController: AbortController | null) {
  const app = new Hono<{ Variables: { abortController: AbortController } }>();
  if (withTimeoutController) {
    app.use("*", async (c, next) => { c.set("abortController", withTimeoutController); await next(); });
  }
  app.all("/v1/*", createProxyHandler({
    allowUnauthenticatedProxy: true,
    resolveTarget: () => target,
    fetchImpl,
  }));
  return app;
}

const req = (signal?: AbortSignal) => new Request("http://gw.local/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json", "X-Provider": "openai" },
  body: JSON.stringify({ model: "gpt-4o" }),
  signal,
});

describe("pass-through proxy abort handling", () => {
  it("gateway request timeout -> 504 timeout_error (not 502)", async () => {
    const { fetchImpl, started } = hangingFetch();
    const timeout = new AbortController();
    const app = mount(fetchImpl, timeout);
    const pending = app.fetch(req());
    await started;
    timeout.abort(createTimeoutReason(10));
    const r = await pending;
    expect(r.status).toBe(504);
    const body = await r.json() as { error: { type: string; code: string } };
    expect(body.error.type).toBe("timeout_error");
    expect(body.error.code).toBe("gateway_timeout");
  });

  it("client abort (no timeout middleware) is not reported as an upstream error", async () => {
    const { fetchImpl, started } = hangingFetch();
    const client = new AbortController();
    const app = mount(fetchImpl, null);
    const pending = app.fetch(req(client.signal));
    await started;
    client.abort();
    const r = await pending;
    expect(r.status).toBe(499);
    const body = await r.json() as { error: { code: string } };
    expect(body.error.code).toBe("client_closed_request");
  });

  it("client abort behind the timeout middleware still aborts the upstream fetch", async () => {
    const { fetchImpl, started } = hangingFetch();
    const client = new AbortController();
    const app = mount(fetchImpl, new AbortController());
    const pending = app.fetch(req(client.signal));
    await started;
    client.abort();
    const r = await Promise.race([
      pending,
      new Promise<"hung">((res) => setTimeout(() => res("hung"), 500)),
    ]);
    expect(r).not.toBe("hung");
    expect((r as Response).status).toBe(499);
  });
});
