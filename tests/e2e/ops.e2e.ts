/** Contract: operational surface (metrics, request logs, CORS preflight, graceful shutdown). */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ADMIN_SECRET, baseConfig, postJson, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

/** True when /metrics has at least one sample (not just HELP/TYPE) for a series whose name ends with `suffix`. */
function hasSample(text: string, suffix: string): boolean {
  return text.split("\n").some((l) => !l.startsWith("#") && new RegExp(`^[a-z_]*${suffix}(\\{| )`).test(l));
}

describe("ops", () => {
  let a: MockUpstream;
  let b: MockUpstream;
  let gw: GatewayProcess;

  beforeAll(async () => {
    a = startMockUpstream("a");
    b = startMockUpstream("b");
    gw = await startGateway({
      config: baseConfig(
        [
          {
            name: "a",
            mock: a,
            extra: { circuitBreaker: { failureThreshold: 1, successThreshold: 1, timeoutMs: 60_000 } },
          },
          { name: "b", mock: b },
        ],
        { cors: { enabled: true, origins: ["https://app.example.com"] } },
      ),
    });
    // Some traffic: a provider error on a (opens its breaker), served by b; then a plain success.
    a.enqueue("500");
    await gw.client().chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    await gw.client().chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  });
  afterAll(async () => {
    await gw?.stop();
    a?.stop();
    b?.stop();
  });

  it("/metrics is public and has request series", async () => {
    const r = await gw.fetch("/metrics", { auth: null });
    expect(r.status).toBe(200);
    expect(hasSample(await r.text(), "requests_total")).toBe(true);
  });

  // B3-6 (fixed in 2.3): token / provider-error / breaker recorders are wired.
  it("/metrics has token, provider error and circuit breaker samples", async () => {
    const text = await (await gw.fetch("/metrics", { auth: null })).text();
    expect(hasSample(text, "tokens_input_total")).toBe(true);
    expect(hasSample(text, "provider_errors_total")).toBe(true);
    expect(hasSample(text, "circuit_breaker_state")).toBe(true);
  });

  // round-2 (fixed in 2.3): finalize writes every request to the log store.
  it("/admin/logs lists the requests that were served", async () => {
    const r = await gw.fetch("/admin/logs", { auth: null, headers: { "X-Admin-Secret": ADMIN_SECRET } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { total: number };
    expect(j.total).toBeGreaterThan(0);
  });

  it("CORS preflight allows the openai SDK's x-stainless-* headers (B3-8)", async () => {
    const requested =
      "authorization,content-type,x-stainless-arch,x-stainless-lang,x-stainless-os,x-stainless-package-version,x-stainless-retry-count,x-stainless-runtime,x-stainless-runtime-version";
    const r = await gw.fetch("/v1/chat/completions", {
      method: "OPTIONS",
      auth: null,
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": requested,
      },
    });
    expect(r.status).toBeLessThan(300);
    const allowed = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/);
    for (const h of requested.split(",")) expect(allowed).toContain(h);
  });
});

describe("graceful shutdown (one request in flight)", () => {
  let up: MockUpstream;
  let g: GatewayProcess;
  let sigtermAt = 0;

  beforeAll(async () => {
    up = startMockUpstream("s");
    // requestTimeout well past the drain grace (SHUTDOWN_GRACE_MS=3000 in the harness).
    g = await startGateway({ config: baseConfig([{ name: "s", mock: up }], { requestTimeout: "20s" }) });
    up.enqueue("hang"); // keeps one request in flight so the drain window stays open
    void postJson(g, "/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }).catch(
      () => undefined,
    );
    while (up.requests.length === 0) await Bun.sleep(10);
  });
  afterAll(async () => {
    await g?.stop("SIGKILL");
    up?.stop();
  });

  it("after SIGTERM the gateway is not ready at once: /readyz 503 or listener closed; new requests refused", async () => {
    sigtermAt = Date.now();
    g.proc.kill("SIGTERM");
    await Bun.sleep(150);
    // Since 9f2972b the listener stops accepting right away; a refused
    // connection is as good as a 503 for a load balancer.
    const ready = await g.fetch("/readyz", { auth: null }).catch(() => undefined);
    if (ready) expect(ready.status).toBe(503);
    const fresh = await postJson(g, "/v1/chat/completions", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    }).catch(() => undefined);
    if (fresh) expect(fresh.status).toBe(503);
    expect(g.proc.exitCode).toBeNull(); // still draining the in-flight request
  });

  // Found by this suite (C3-7/B3-9 area): the process kept running past the
  // grace until the hung request hit requestTimeout. Fixed: forced
  // server.stop(true) once the grace expires, then exit.
  it("process exits within the drain grace even with a hung request", async () => {
    const exited = await Promise.race([g.proc.exited.then(() => true), Bun.sleep(6000).then(() => false)]);
    expect(exited).toBe(true);
    expect(Date.now() - sigtermAt).toBeLessThan(6000);
  }, 10000);
});
