/**
 * Gateway.reload (0.3.0 P0): live config through atomic runtime snapshots.
 *
 * Contract:
 *  - after reload, new requests use the new config; the version goes up by one;
 *  - a request (stream included) already running keeps the snapshot it began on;
 *  - an invalid config throws and the old snapshot keeps serving;
 *  - mcpServers is startup-only;
 *  - unchanged breakers / limiters / plugins keep their state, changed ones start fresh;
 *  - runtime-registered providers survive a reload;
 *  - sustained traffic during a burst of reloads sees no errors.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { GatewayConfig } from "../../src/config/types.js";
import { Gateway, ReloadRejectedError } from "../../src/gateway.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  IProvider,
  RequestContext,
} from "../../src/providers/types.js";

// ── mock OpenAI-compatible upstreams: reply with their own name ──

let gate: { promise: Promise<void>; release: () => void } = newGate();
function newGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

function chunk(id: string, content: string, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content: `${id}:${content}` }, finish_reason: finish }],
  })}\n\n`;
}

function startUpstream(id: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { stream?: boolean };
      if (body.stream) {
        const enc = new TextEncoder();
        const holdOn = req.headers.get("x-hold") === "1";
        const stream = new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode(chunk(id, "first", null)));
            if (holdOn) await gate.promise;
            c.enqueue(enc.encode(chunk(id, "last", "stop")));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: id }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

const upA = startUpstream("A");
const upB = startUpstream("B");
const url = (s: ReturnType<typeof Bun.serve>) => `http://127.0.0.1:${s.port}/v1`;

afterAll(() => {
  upA.stop(true);
  upB.stop(true);
});

let savedNoProxy: string | undefined;
beforeAll(() => {
  savedNoProxy = process.env["NO_PROXY"];
  process.env["NO_PROXY"] = "127.0.0.1,localhost";
});
afterAll(() => {
  if (savedNoProxy === undefined) delete process.env["NO_PROXY"];
  else process.env["NO_PROXY"] = savedNoProxy;
});

function target(name: string, up: ReturnType<typeof Bun.serve>, extra: Record<string, unknown> = {}) {
  return { name, provider: "openai", apiKey: `sk-${name}`, baseURL: url(up), models: ["m"], ...extra };
}

function cfg(only: "a" | "b", extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    strategy: { mode: "single", targets: [only] },
    targets: [target(only, only === "a" ? upA : upB)],
    ...extra,
  } as GatewayConfig;
}

const req = (): [RequestContext, ChatCompletionRequest] => [
  { metadata: { api_key: "k1" } } as RequestContext,
  { model: "m", messages: [{ role: "user", content: "hi" }] } as ChatCompletionRequest,
];

async function ask(gw: Gateway): Promise<string> {
  const [ctx, r] = req();
  const res = await gw.route(ctx, r);
  return String(res.choices[0]?.message?.content);
}

describe("Gateway.reload", () => {
  it("routes new requests by the new config and bumps the version", async () => {
    const gw = new Gateway(cfg("a"));
    expect(gw.currentSnapshot().version).toBe(1);
    expect(await ask(gw)).toBe("A");

    const snap = gw.reload(cfg("b"));
    expect(snap.version).toBe(2);
    expect(gw.getConfig().targets[0]?.name).toBe("b");
    expect(await ask(gw)).toBe("B");
    expect(gw.listModels().map((m) => m.id)).toContain("m");
  });

  it("lets a stream started before the reload finish on its original target", async () => {
    gate = newGate();
    // The upstream holds the stream open between its two chunks until the gate opens.
    const gw = new Gateway(cfg("a"));
    const [ctx, r] = req();
    // Tag this one upstream call so the mock holds it (fetch is read when the call starts).
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const h = new Headers(init?.headers);
      h.set("x-hold", "1");
      return origFetch(input, { ...init, headers: h });
    }) as typeof fetch;
    let stream: AsyncGenerator<unknown>;
    let first: IteratorResult<unknown>;
    try {
      stream = gw.routeStream(ctx, { ...r, stream: true });
      first = await stream.next();
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(JSON.stringify(first.value)).toContain("A:first");

    // Swap to a config without target "a" while the stream is mid-flight.
    gw.reload(cfg("b"));
    expect(await ask(gw)).toBe("B");

    gate.release();
    const rest: string[] = [];
    for await (const c of stream) rest.push(JSON.stringify(c));
    expect(rest.join("")).toContain("A:last");
    expect(rest.join("")).not.toContain("B:");
  });

  it("keeps serving the old config when the new one is invalid", async () => {
    const gw = new Gateway(cfg("a"));
    const bad = { ...cfg("b"), strategy: { mode: "single", targets: ["nope"] } } as GatewayConfig;
    expect(() => gw.reload(bad)).toThrow();
    expect(gw.currentSnapshot().version).toBe(1);
    expect(await ask(gw)).toBe("A");
  });

  it("rejects a change to mcpServers", () => {
    const gw = new Gateway(cfg("a"));
    const withMcp = cfg("a", {
      mcpServers: [{ name: "x", command: "true" }],
    } as unknown as Partial<GatewayConfig>);
    expect(() => gw.reload(withMcp)).toThrow(ReloadRejectedError);
    expect(gw.currentSnapshot().version).toBe(1);
  });

  it("carries an unchanged breaker over and replaces a changed one", () => {
    const breaker = { failureThreshold: 3, successThreshold: 1, maxHalfThreshold: 1, timeoutMs: 30000 };
    const base = {
      strategy: { mode: "single", targets: ["a"] },
      targets: [target("a", upA, { circuitBreaker: breaker })],
    };
    const gw = new Gateway(base as GatewayConfig);
    const b1 = gw.getCircuitBreakerRegistry().get("a");
    expect(b1).toBeDefined();

    gw.reload({ ...base, aliases: { x: "m" } } as GatewayConfig);
    expect(gw.getCircuitBreakerRegistry().get("a")).toBe(b1);

    gw.reload({
      ...base,
      targets: [target("a", upA, { circuitBreaker: { ...breaker, failureThreshold: 9 } })],
    } as GatewayConfig);
    const b3 = gw.getCircuitBreakerRegistry().get("a");
    expect(b3).toBeDefined();
    expect(b3).not.toBe(b1);
  });

  it("carries an unchanged concurrency limiter over (in-flight slots kept)", () => {
    const base = {
      strategy: { mode: "single", targets: ["a"] },
      targets: [target("a", upA, { concurrency: { maxConcurrency: 2, queueSize: 0 } })],
    };
    const gw = new Gateway(base as GatewayConfig);
    const l1 = gw.getConcurrencyLimiterRegistry().get("a");
    gw.reload({ ...base, aliases: { y: "m" } } as GatewayConfig);
    expect(gw.getConcurrencyLimiterRegistry().get("a")).toBe(l1);
  });

  it("keeps rate-limit windows when the plugin is unchanged and resets them when it changes", async () => {
    const plugin = (rpm: number) => [
      { name: "rate-limit", stage: "before_request", config: { maxRequestsPerMinute: rpm } },
    ];
    const gw = new Gateway(cfg("a", { plugins: plugin(2) } as Partial<GatewayConfig>));
    await ask(gw);
    await ask(gw);
    await expect(ask(gw)).rejects.toThrow();

    // Unrelated change: the window (2/2 used) carries over.
    gw.reload(cfg("b", { plugins: plugin(2) } as Partial<GatewayConfig>));
    await expect(ask(gw)).rejects.toThrow();

    // Changed limit: a fresh plugin with a fresh window.
    gw.reload(cfg("b", { plugins: plugin(3) } as Partial<GatewayConfig>));
    expect(await ask(gw)).toBe("B");
  });

  it("keeps runtime-registered providers across reloads", async () => {
    const custom: IProvider = {
      name: "custom",
      async complete(): Promise<ChatCompletionResponse> {
        return {
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "custom" }, finishReason: "stop" }],
        } as unknown as ChatCompletionResponse;
      },
      supportedModels: () => ["m"],
      supportsModel: (m: string) => m === "m",
      models: () => [{ id: "m", object: "model", ownedBy: "custom" }],
    } as unknown as IProvider;
    const gw = new Gateway(cfg("a"));
    gw.registerProvider(custom);
    gw.reload(cfg("b"));
    expect(gw.getRegistry().get("custom")).toBe(custom);
  });

  it("notifies reload listeners with the new snapshot", () => {
    const gw = new Gateway(cfg("a"));
    const seen: number[] = [];
    const off = gw.onReload((s) => seen.push(s.version));
    gw.reload(cfg("b"));
    off();
    gw.reload(cfg("a"));
    expect(seen).toEqual([2]);
  });

  it("serves sustained traffic through 1000 reloads with zero errors", async () => {
    const gw = new Gateway(cfg("a"));
    let stop = false;
    let ok = 0;
    const served = new Set<string>();
    const errors: unknown[] = [];
    const worker = async () => {
      while (!stop) {
        try {
          const [ctx, r] = req();
          if (ok % 3 === 0) {
            for await (const _ of gw.routeStream(ctx, { ...r, stream: true })) void _;
          } else {
            const who = await ask(gw);
            if (who !== "A" && who !== "B") throw new Error(`unexpected ${who}`);
            served.add(who);
          }
          ok++;
        } catch (err) {
          errors.push(err);
        }
      }
    };
    const workers = Array.from({ length: 16 }, worker);
    for (let i = 0; i < 1000; i++) {
      gw.reload(cfg(i % 2 === 0 ? "b" : "a"));
      if (i % 10 === 0) await Bun.sleep(1);
    }
    await Bun.sleep(50);
    stop = true;
    await Promise.all(workers);
    expect(errors).toEqual([]);
    expect(ok).toBeGreaterThan(100);
    expect([...served].sort()).toEqual(["A", "B"]);
    expect(gw.currentSnapshot().version).toBe(1001);
  }, 30_000);
});
