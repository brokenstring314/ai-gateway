/**
 * In-process harness for the runtime-config Admin API (0.3.0 P4): a config
 * store (in memory, real encryption), a Gateway built from it, the full
 * Hono app with a key store, and fake upstreams.
 *
 * Upstreams are host names under `.upstream.test`, answered by a stubbed
 * global fetch (no sockets), so channels created through the Admin API can
 * use them: the injected DNS resolver maps every name to a public address
 * unless a test says otherwise (`dns`). A public-policy channel's request is
 * pinned to the checked address (RA3): it arrives for the IP with the name in
 * the Host header; the fake answers by that name and records the IP
 * (`UpstreamCall.connectedTo`).
 */
import { Database } from "bun:sqlite";
import { isIP } from "node:net";
import { createApp } from "../../src/app.js";
import { loadConfigFromObject } from "../../src/config/loader.js";
import { composeConfig } from "../../src/config/runtime-source.js";
import { Gateway } from "../../src/gateway.js";
import { ConfigStore } from "../../src/persistence/config-store.js";
import { KeyStore } from "../../src/persistence/key-store.js";
import type { RequestLogStore } from "../../src/persistence/request-log-store.js";
import { SecretBox } from "../../src/secrets/secret-box.js";
import { PublicHostGuard } from "../../src/security/url-guard.js";
import { persistKeyHealth } from "../../src/server/bootstrap.js";
import { UsageRecorder } from "../../src/usage/recorder.js";
import { UsageStore } from "../../src/usage/usage-store.js";

export type Reply = number | { status: number; headers?: Record<string, string>; body?: unknown; text?: string };

export interface UpstreamCall {
  readonly host: string;
  readonly path: string;
  readonly auth: string | null;
  readonly body: any;
  /** The address the request was sent to: the checked IP for a pinned (public-policy) request, else the host. */
  readonly connectedTo: string;
}

/** The URL a request is for: a pinned request goes to an IP with the host name in its Host header. */
export function logicalUrl(input: string | URL | Request, init?: RequestInit): { url: URL; connectedTo: string } {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const connectedTo = url.hostname.replace(/^\[|\]$/g, "");
  const host = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("host");
  if (host && isIP(connectedTo) !== 0) url.host = host;
  return { url, connectedTo };
}

export class FakeUpstreams {
  readonly calls: UpstreamCall[] = [];
  private readonly queues = new Map<string, Reply[]>();
  /** Per host: answer by Authorization header (e.g. a revoked key). */
  readonly byAuth = new Map<string, (auth: string | null) => Reply | undefined>();
  /** Answer every call after this many ms (requests overlap in flight); reset() clears it. */
  delayMs = 0;
  private original: typeof fetch | undefined;

  enqueue(host: string, ...replies: Reply[]): void {
    this.queues.set(host, [...(this.queues.get(host) ?? []), ...replies]);
  }

  reset(): void {
    this.calls.length = 0;
    this.queues.clear();
    this.byAuth.clear();
    this.delayMs = 0;
  }

  hits(host: string): UpstreamCall[] {
    return this.calls.filter((c) => c.host === host);
  }

  install(): void {
    this.original = globalThis.fetch;
    const original = this.original;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const { url, connectedTo } = logicalUrl(input, init);
      if (!url.hostname.endsWith(".upstream.test")) return original(input as never, init);
      return this.answer(url, init, connectedTo);
    }) as typeof fetch;
  }

  uninstall(): void {
    if (this.original) globalThis.fetch = this.original;
  }

  private async answer(url: URL, init?: RequestInit, connectedTo = url.hostname): Promise<Response> {
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const call: UpstreamCall = {
      host: url.hostname,
      path: url.pathname,
      auth: headers.get("authorization"),
      body,
      connectedTo,
    };
    this.calls.push(call);
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    const reply = this.byAuth.get(url.hostname)?.(call.auth) ?? this.queues.get(url.hostname)?.shift() ?? 200;
    const r = typeof reply === "number" ? { status: reply } : reply;
    if (r.status !== 200 || r.body !== undefined || r.text !== undefined) {
      const payload =
        r.text ?? JSON.stringify(r.body ?? { error: { message: `upstream ${r.status}`, type: "upstream_error" } });
      return new Response(payload, { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
    }
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "up-model-1" }, { id: "up-model-2" }] });
    }
    const model = String(body?.model ?? "");
    const content = `${url.hostname.split(".")[0]}:${model}`;
    if (body?.stream === true) {
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(`${chunk({ role: "assistant", content })}${chunk({}, "stop")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
}

export const PUBLIC_IP = "93.184.216.34";

export interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly gateway: Gateway;
  readonly store: ConfigStore;
  readonly keyStore: KeyStore;
  /** Usage rollups (in memory) and their recorder (no timer: GET /admin/usage flushes). */
  readonly usageStore: UsageStore;
  readonly recorder: UsageRecorder;
  readonly keys: { admin: string; readOnly: string; inference: string };
  /** host → addresses; unset hosts resolve to PUBLIC_IP. */
  readonly dns: Map<string, string[]>;
  admin(
    method: string,
    path: string,
    body?: unknown,
    opts?: { key?: string | null; ifMatch?: string | number; headers?: Record<string, string> },
  ): Promise<Response>;
  chat(model: string, opts?: { key?: string; stream?: boolean }): Promise<Response>;
  /** GET + ETag. */
  etagOf(path: string): Promise<string>;
}

/** A target on a fake upstream (trusted: from the config file). */
export function yamlTarget(name: string, models: string[] = ["gpt-x"], extra: Record<string, unknown> = {}) {
  return {
    name,
    provider: "openai",
    apiKey: `sk-yaml-${name}-0123456789`,
    baseURL: `https://${name}.upstream.test/v1`,
    models,
    ...extra,
  };
}

export async function adminHarness(
  file: Record<string, unknown>,
  opts: {
    store?: boolean;
    probe?: { perActorPerMinute?: number; globalPerMinute?: number };
    /** Persisted request log behind GET /admin/logs. */
    logStore?: RequestLogStore;
  } = {},
): Promise<Harness> {
  const config0 = loadConfigFromObject(file);
  const dns = new Map<string, string[]>();
  const resolver = async (host: string) => {
    const found = dns.get(host);
    if (found) return found;
    if (host === "nx.upstream.test") throw new Error("ENOTFOUND");
    return [PUBLIC_IP];
  };
  let store: ConfigStore | undefined;
  let config = config0;
  if (opts.store !== false) {
    store = await ConfigStore.create(new Database(":memory:"), await SecretBox.create(new Uint8Array(32).fill(5)));
    await store.importFromConfig(config0);
    config = composeConfig(config0, await store.loadRuntimeSections());
  }
  const gateway = new Gateway(config, { publicHostGuard: new PublicHostGuard(resolver, 0) });
  const keyStore = await KeyStore.create(new Database(":memory:"));
  const keys = {
    admin: keyStore.create("admin", ["admin"]).key,
    readOnly: keyStore.create("ro", ["read_only"]).key,
    inference: keyStore.create("inf", ["inference"]).key,
  };
  if (store) persistKeyHealth(gateway, store);
  const usageStore = await UsageStore.create(new Database(":memory:"));
  const recorder = new UsageRecorder({ store: usageStore, meter: gateway.keyMeter(), keyStore, intervalMs: 0 });
  const app = createApp(gateway, config, undefined, keyStore, {
    usageStore,
    usageRecorder: recorder,
    ...(store ? { configStore: store } : {}),
    ...(opts.logStore ? { logStore: opts.logStore } : {}),
    configApi: { resolver, probe: opts.probe ?? {} },
  });
  const admin: Harness["admin"] = async (method, path, body, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.key !== null) headers["authorization"] ??= `Bearer ${o.key ?? keys.admin}`;
    if (body !== undefined) headers["content-type"] ??= "application/json";
    if (o.ifMatch !== undefined) headers["if-match"] = String(o.ifMatch);
    return app.request(`/admin${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  };
  return {
    app,
    gateway,
    store: store as ConfigStore,
    keyStore,
    usageStore,
    recorder,
    keys,
    dns,
    admin,
    chat: async (model, o = {}) =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${o.key ?? keys.inference}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          ...(o.stream ? { stream: true } : {}),
        }),
      }),
    async etagOf(path) {
      const r = await admin("GET", path);
      const tag = r.headers.get("etag");
      if (!tag) throw new Error(`no ETag on ${path} (${r.status})`);
      return tag;
    },
  };
}
