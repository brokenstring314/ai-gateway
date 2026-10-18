// 2.4: embeddings / images go through the pipeline surfaces; encoding_format,
// quality and style reach the upstream; a client disconnect aborts upstream.
import { afterEach, describe, expect, it } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";

let stops: (() => void)[] = [];
afterEach(() => { for (const s of stops) s(); stops = []; });

function upstream(handler: (path: string, body: any, req: Request) => Response | Promise<Response>) {
  const bodies: { path: string; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.json().catch(() => undefined);
      bodies.push({ path, body });
      return handler(path, body, req);
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1`, bodies };
}

function app(baseURL: string) {
  const cfg: any = { auth: { enabled: false }, strategy: { mode: "single", targets: ["a"] }, targets: [{ name: "a", provider: "openai", apiKey: "k", baseURL, models: ["e", "dall-e-3"] }] };
  return createApp(new Gateway(cfg), cfg);
}
const post = (a: ReturnType<typeof app>, path: string, body: unknown, init: RequestInit = {}) =>
  a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });

describe("embeddings / images parameters", () => {
  it("encoding_format reaches upstream; a base64 embedding is passed through", async () => {
    const up = upstream(() => Response.json({ object: "list", model: "e", data: [{ object: "embedding", index: 0, embedding: "AACAPw==" }], usage: { prompt_tokens: 1, total_tokens: 1 } }));
    const r = await post(app(up.url), "/v1/embeddings", { model: "e", input: "x", encoding_format: "base64" });
    expect(r.status).toBe(200);
    expect(up.bodies[0]?.body.encoding_format).toBe("base64");
    const j = (await r.json()) as { data: { embedding: unknown }[] };
    expect(j.data[0]?.embedding).toBe("AACAPw==");
  });

  it("invalid encoding_format is a 400", async () => {
    const up = upstream(() => Response.json({}));
    expect((await post(app(up.url), "/v1/embeddings", { model: "e", input: "x", encoding_format: "int8" })).status).toBe(400);
    expect(up.bodies.length).toBe(0);
  });

  it("images quality and style reach upstream", async () => {
    const up = upstream(() => Response.json({ created: 1, data: [{ url: "https://x/y.png" }] }));
    const r = await post(app(up.url), "/v1/images/generations", { model: "dall-e-3", prompt: "cat", quality: "hd", style: "natural" });
    expect(r.status).toBe(200);
    expect(up.bodies[0]?.body).toMatchObject({ quality: "hd", style: "natural" });
  });

  it("client disconnect aborts the upstream embeddings request", async () => {
    let upstreamAborted = false;
    const up = upstream((_p, _b, req) => new Promise<Response>((resolve) => {
      req.signal.addEventListener("abort", () => { upstreamAborted = true; resolve(new Response("gone", { status: 499 })); });
    }));
    const client = new AbortController();
    const pending = post(app(up.url), "/v1/embeddings", { model: "e", input: "x" }, { signal: client.signal }).catch(() => undefined);
    await Bun.sleep(50);
    client.abort();
    await pending;
    for (let i = 0; i < 50 && !upstreamAborted; i++) await Bun.sleep(10);
    expect(upstreamAborted).toBe(true);
  });
});
