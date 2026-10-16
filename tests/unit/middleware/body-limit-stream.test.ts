import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { bodyLimitMiddleware } from "@/middleware/body-limit";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { KeyStore } from "@/persistence/key-store";
import type { GatewayConfig } from "@/config/types";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });

function bigStream(total: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (sent >= total) { ctrl.close(); return; }
      const n = Math.min(chunk, total - sent);
      ctrl.enqueue(new Uint8Array(n).fill(97));
      sent += n;
    },
  });
}

async function postStream(url: string, total: number, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers,
    body: bigStream(total),
    // @ts-expect-error bun supports duplex
    duplex: "half",
  });
}

describe("bodyLimitMiddleware — streamed bodies", () => {
  it("rejects a chunked request (no Content-Length) over the limit with 413", async () => {
    const app = new Hono();
    app.use("*", bodyLimitMiddleware(1024));
    let reached = false;
    app.post("/x", async (c) => { reached = true; return c.text(String((await c.req.arrayBuffer()).byteLength)); });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const res = await postStream(`http://127.0.0.1:${server.port}/x`, 2 * 1024 * 1024);
    expect(res.status).toBe(413);
    expect(reached).toBe(false);
  });

  it("passes a chunked request under the limit through intact", async () => {
    const app = new Hono();
    app.use("*", bodyLimitMiddleware(1024 * 1024));
    app.post("/x", async (c) => c.text(String((await c.req.arrayBuffer()).byteLength)));
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const res = await postStream(`http://127.0.0.1:${server.port}/x`, 200 * 1024);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(String(200 * 1024));
  });

  it("rejects non-numeric / negative / list Content-Length with 400", async () => {
    const app = new Hono();
    app.use("*", bodyLimitMiddleware(10));
    app.post("/x", (c) => c.text("reached"));
    for (const cl of ["abc", "-1", "5, 5", "1e3"]) {
      const res = await app.request("/x", { method: "POST", headers: { "Content-Length": cl }, body: "x" });
      expect(res.status).toBe(400);
    }
  });

  it("covers the /v1 proxy path: oversized chunked body is 413 before the proxy reads it", async () => {
    const config: GatewayConfig = {
      strategy: { mode: "single", targets: ["mock"] },
      targets: [{ name: "mock", provider: "openai", apiKey: "sk-target-secret", baseURL: "http://127.0.0.1:1/v1", models: ["gpt-4o"] }],
      maxRequestBytes: 4096,
      auth: { enabled: true, keys: ["sk-client-key-abc"] },
      passthroughProxy: { enabled: true },
    };
    const keyStore = await KeyStore.create(new Database(":memory:"));
    const app = createApp(new Gateway(config), config, undefined, keyStore);
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const res = await postStream(`http://127.0.0.1:${server.port}/v1/responses`, 1024 * 1024, {
      Authorization: "Bearer sk-client-key-abc",
      "X-Provider": "mock",
    });
    expect(res.status).toBe(413);
  });
});
