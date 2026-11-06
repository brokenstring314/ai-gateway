/**
 * Final red team 2026-11-06 (SSRF / upstream area):
 *
 * FS-1: the typed routes read upstream bodies with `response.json()`, whole and
 * after Bun's automatic decompression: a 255 KB gzip answer (256 MiB decoded)
 * pushed the gateway to ~800 MB RSS, and the error path did the same
 * (repros/ssrf/t1_decompression_bomb.sh). Now every non-streaming body is read
 * with a bounded reader on the decompressed bytes: 32 MiB for successes, 64 KiB
 * for error bodies (configurable), over the limit → 502
 * `upstream_response_too_large` and the upstream transfer is cancelled.
 *
 * FS-2: the pass-through copied `Content-Encoding: gzip` (and Content-Length)
 * from the upstream onto a body Bun had already decoded, so every standard
 * client failed to read /v1/responses; the upstream's `Set-Cookie` reached the
 * gateway's origin too (repros/ssrf/t2_passthrough_content_encoding.sh).
 *
 * A real loopback HTTP server is used (not a fake fetch): decompression only
 * happens inside Bun's fetch.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { createApp } from "@/app";
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import { KeyStore } from "@/persistence/key-store";

const PORT = 4762;
const MiB = 1024 * 1024;

/** A gzip JSON chat completion whose content is `mb` MiB of "A". */
function chatBomb(mb: number): Uint8Array {
  const head =
    '{"id":"c1","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"';
  const tail = '"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}';
  const body = Buffer.alloc(head.length + mb * MiB + tail.length, 0x41);
  body.write(head, 0);
  body.write(tail, body.length - tail.length);
  return gzipSync(body, { level: 9 });
}

const BOMB_64 = chatBomb(64); // over the 32 MiB default
const BOMB_2 = chatBomb(2); // over a 1 MiB configured limit
let server: ReturnType<typeof Bun.serve>;
let lastAcceptEncoding: string | null = null;

const gz = (status: number, body: Uint8Array, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json", "content-encoding": "gzip", ...extra },
  });

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      lastAcceptEncoding = req.headers.get("accept-encoding");
      const text = req.method === "POST" ? await req.text() : "";
      let model = "";
      try {
        model = (JSON.parse(text) as { model?: string }).model ?? "";
      } catch {
        // not JSON
      }
      if (model === "bomb64") return gz(200, BOMB_64);
      if (model === "bomb2") return gz(200, BOMB_2);
      if (model === "errbomb") return gz(400, BOMB_64);
      if (model === "small-gz") {
        const ok = {
          id: "c",
          object: "chat.completion",
          created: 1,
          model: "small-gz",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        return gz(200, gzipSync(Buffer.from(JSON.stringify(ok))));
      }
      if (path.endsWith("/embeddings")) return gz(200, BOMB_2);
      if (path.endsWith("/images/generations")) return gz(200, BOMB_2);
      if (path.endsWith("/responses") && model === "gz") {
        return gz(
          200,
          gzipSync(Buffer.from(JSON.stringify({ id: "resp_1", object: "response", output_text: "hello" }))),
          {
            "set-cookie": "aigw_session=attacker; Path=/admin; HttpOnly",
            "strict-transport-security": "max-age=99999999",
            "clear-site-data": '"cookies"',
          },
        );
      }
      if (path.endsWith("/responses") && model === "bomb2") return gz(200, BOMB_2);
      if (path.endsWith("/responses") && model === "declared-huge") {
        return new Response(new Uint8Array(2 * MiB), { headers: { "content-type": "application/octet-stream" } });
      }
      return Response.json({ error: { message: `unexpected ${path} ${model}` } }, { status: 500 });
    },
  });
});
afterAll(() => server.stop(true));

async function setup(extra: Record<string, unknown> = {}) {
  const config = loadConfigFromObject({
    strategy: { mode: "single" },
    targets: [
      {
        name: "up",
        provider: "openai",
        apiKey: "sk-up-0123456789",
        baseURL: `http://127.0.0.1:${PORT}/v1`,
        models: ["bomb64", "bomb2", "errbomb", "small-gz", "emb", "img", "gz", "declared-huge"],
      },
    ],
    auth: { enabled: true },
    passthroughProxy: { enabled: true },
    ...extra,
  });
  const store = await KeyStore.create(new Database(":memory:"));
  const key = store.create("k", ["inference"]).key;
  const app = createApp(new Gateway(config), config, undefined, store);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { post };
}

type Err = { error: { code: string; message: string } };
const chat = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("FS-1 upstream bodies are read with a bound on the decompressed size", () => {
  it("t1 repro: a 64 MiB gzip bomb on non-stream chat is a 502 upstream_response_too_large (32 MiB default)", async () => {
    const { post } = await setup();
    const before = process.memoryUsage().rss;
    const r = await post("/v1/chat/completions", chat("bomb64")); // was 200 with the whole body, ~800 MB RSS
    expect(r.status).toBe(502);
    const body = (await r.json()) as Err;
    expect(body.error.code).toBe("upstream_response_too_large");
    // Reading stopped at the limit: nowhere near the 64 MiB decoded body twice over (string + JSON).
    expect(process.memoryUsage().rss - before).toBeLessThan(160 * MiB);
  });

  it("the limit is configurable: maxUpstreamResponseBytes: 1 MiB refuses a 2 MiB body on chat, completions, embeddings, images", async () => {
    const { post } = await setup({ maxUpstreamResponseBytes: MiB });
    const results = [
      await post("/v1/chat/completions", chat("bomb2")),
      await post("/v1/completions", { model: "bomb2", prompt: "hi" }),
      await post("/v1/embeddings", { model: "emb", input: "hi" }),
      await post("/v1/images/generations", { model: "img", prompt: "hi" }),
    ];
    for (const r of results) {
      expect(r.status).toBe(502);
      expect(((await r.json()) as Err).error.code).toBe("upstream_response_too_large");
    }
  });

  it("a JSON body answering a stream request is bounded the same way", async () => {
    const { post } = await setup({ maxUpstreamResponseBytes: MiB });
    const r = await post("/v1/chat/completions", chat("bomb2", { stream: true }));
    const text = await r.text();
    expect(text).toContain("upstream_response_too_large");
    expect(text.length).toBeLessThan(10_000);
  });

  it("an upstream error body is read at most 64 KiB: the status survives, the bomb is not decoded", async () => {
    const { post } = await setup();
    const before = process.memoryUsage().rss;
    const r = await post("/v1/chat/completions", chat("errbomb")); // was ~400 MB RSS
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text.length).toBeLessThan(10_000);
    // Reading stopped at 64 KiB: the message says so (before: the whole body was decoded and parsed).
    expect((JSON.parse(text) as Err).error.message).toBe("HTTP 400 (error body too large)");
    expect(process.memoryUsage().rss - before).toBeLessThan(160 * MiB);
  });

  it("a normal gzip answer still works", async () => {
    const { post } = await setup();
    const r = await post("/v1/chat/completions", chat("small-gz"));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe(
      "ok",
    );
  });

  it("config validation: the limits have sane bounds", () => {
    expect(() => loadConfigFromObject({ ...baseFile(), maxUpstreamResponseBytes: 10 })).toThrow();
    expect(() => loadConfigFromObject({ ...baseFile(), maxUpstreamErrorBodyBytes: 0 })).toThrow();
    expect(loadConfigFromObject({ ...baseFile(), maxUpstreamErrorBodyBytes: 4096 }).maxUpstreamErrorBodyBytes).toBe(
      4096,
    );
  });
});

function baseFile() {
  return {
    strategy: { mode: "single" },
    targets: [
      { name: "x", provider: "openai", apiKey: "sk-x-0123456789", baseURL: "https://x.test/v1", models: ["m"] },
    ],
  };
}

describe("FS-2 pass-through success responses carry no stale encoding headers and no upstream cookies", () => {
  it("t2 repro: gzip upstream → decoded body without Content-Encoding / Content-Length / Set-Cookie / HSTS / Clear-Site-Data", async () => {
    const { post } = await setup();
    const r = await post("/v1/responses", { model: "gz", input: "hi" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBeNull(); // was "gzip" over a plain body
    expect(r.headers.get("set-cookie")).toBeNull(); // was aigw_session=attacker; Path=/admin
    expect(r.headers.get("strict-transport-security")).toBeNull();
    expect(r.headers.get("clear-site-data")).toBeNull();
    const declared = r.headers.get("content-length");
    const text = await r.text();
    if (declared !== null) expect(Number(declared)).toBe(Buffer.byteLength(text));
    expect(JSON.parse(text)).toEqual({ id: "resp_1", object: "response", output_text: "hello" });
  });

  it("a client asking for an encoding Bun cannot decode still gets a readable body", async () => {
    const { post } = await setup();
    const r = await post("/v1/responses", { model: "gz", input: "hi" }, { "accept-encoding": "x-custom-codec" });
    expect(JSON.parse(await r.text())).toMatchObject({ id: "resp_1" });
    // The client's Accept-Encoding is not forwarded: Bun asks for what it decodes itself.
    expect(lastAcceptEncoding ?? "").not.toContain("x-custom-codec");
  });

  it("non-stream pass-through bodies are bounded: a declared length over the limit is a 502, a decoded body past it is cut", async () => {
    const { post } = await setup({ maxUpstreamResponseBytes: MiB });
    const declared = await post("/v1/responses", { model: "declared-huge", input: "hi" });
    expect(declared.status).toBe(502);
    expect(((await declared.json()) as Err).error.code).toBe("upstream_response_too_large");
    const bomb = await post("/v1/responses", { model: "bomb2", input: "hi" });
    expect(bomb.headers.get("content-encoding")).toBeNull();
    let read = 0;
    let failed = false;
    try {
      const reader = bomb.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(read).toBeLessThanOrEqual(MiB);
  });
});
