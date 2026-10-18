/**
 * Spawns the real gateway (`bun src/index.ts serve -c <tmp config>`) on a
 * random port with a temporary GATEWAY_DATA_DIR, waits for /livez, collects
 * stdout/stderr, and stops it with a signal.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import OpenAI from "openai";
import type { MockUpstream } from "./mock-upstream";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const CLIENT_KEY = "sk-e2e-client-key";
export const ADMIN_SECRET = "e2e-admin-secret-0123456789";

export interface GatewayProcess {
  readonly base: string; // http://127.0.0.1:<port>
  readonly port: number;
  readonly proc: ReturnType<typeof Bun.spawn>;
  /** Everything the process printed so far (stdout + stderr). */
  logs(): string;
  /** OpenAI SDK client pointed at the gateway (no retries). */
  client(opts?: { apiKey?: string; timeoutMs?: number }): OpenAI;
  /** fetch against the gateway; sends the client key unless `auth` is null or another key. */
  fetch(path: string, init?: RequestInit & { auth?: string | null }): Promise<Response>;
  /** Send `signal` and wait for exit (SIGKILL after `timeoutMs`). Returns the exit code. */
  stop(signal?: NodeJS.Signals, timeoutMs?: number): Promise<number | null>;
}

export interface StartOptions {
  /** Config object; written as JSON (the loader accepts .json). */
  config: Record<string, unknown>;
  /** Entry point: index (default) = src/index.ts, cli = src/cli/index.ts. */
  entry?: "index" | "cli";
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** Base config: auth on with one static client key, admin secret, the given targets (fallback when >1). */
export function baseConfig(targets: { name: string; mock: MockUpstream; extra?: Record<string, unknown> }[], extra: Record<string, unknown> = {}) {
  return {
    strategy: { mode: targets.length > 1 ? "fallback" : "single", targets: targets.map((t) => t.name) },
    targets: targets.map((t) => ({
      name: t.name,
      provider: "openai",
      apiKey: `sk-upstream-${t.name}`,
      baseURL: t.mock.url,
      models: ["gpt-4o", "text-embedding-3-small", "dall-e-3", "gpt-3.5-turbo-instruct"],
      ...t.extra,
    })),
    auth: { enabled: true, keys: [CLIENT_KEY] },
    adminSecret: ADMIN_SECRET,
    requestTimeout: "10s",
    ...extra,
  };
}

export async function startGateway(opts: StartOptions): Promise<GatewayProcess> {
  const dir = mkdtempSync(join(tmpdir(), "aigw-e2e-"));
  const port = await freePort();
  const config = { ...opts.config, server: { host: "127.0.0.1", ...(opts.config["server"] as object | undefined), port } };
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  const entry = opts.entry === "cli" ? "src/cli/index.ts" : "src/index.ts";

  const proc = Bun.spawn([process.execPath, entry, "serve", "-c", cfgPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GATEWAY_DATA_DIR: join(dir, "data"),
      // Keep any per-IP limiter out of the way of the test client.
      RATE_LIMIT_RPS: "100000",
      RATE_LIMIT_BURST: "100000",
      SHUTDOWN_GRACE_MS: "3000",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let out = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    try {
      for await (const c of stream) out += dec.decode(c, { stream: true });
    } catch { /* process gone */ }
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 15_000);
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(`${base}/livez`);
      if (r.ok) { ready = true; break; }
    } catch { /* not listening yet */ }
    await Bun.sleep(50);
  }
  if (!ready) {
    proc.kill("SIGKILL");
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`gateway did not become live on ${base}\n--- logs ---\n${out}`);
  }

  return {
    base,
    port,
    proc,
    logs: () => out,
    client: (o = {}) => new OpenAI({ apiKey: o.apiKey ?? CLIENT_KEY, baseURL: `${base}/v1`, maxRetries: 0, timeout: o.timeoutMs ?? 15_000 }),
    fetch: (path, init = {}) => {
      const { auth, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (auth !== null && !headers.has("authorization")) headers.set("authorization", `Bearer ${auth ?? CLIENT_KEY}`);
      return fetch(`${base}${path}`, { ...rest, headers });
    },
    async stop(signal = "SIGTERM", timeoutMs = 8000) {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill(signal);
        const t = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
        await proc.exited;
        clearTimeout(t);
      }
      rmSync(dir, { recursive: true, force: true });
      return proc.exitCode;
    },
  };
}

/** POST JSON (raw fetch, for asserting on status/headers the SDK hides). */
export function postJson(gw: GatewayProcess, path: string, body: unknown, init: RequestInit & { auth?: string | null } = {}) {
  return gw.fetch(path, { ...init, method: "POST", headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) }, body: JSON.stringify(body) });
}

/** Read an SSE body for at most `ms`; returns the text so far and whether the stream ended. */
export async function readFor(res: Response, ms: number): Promise<{ text: string; ended: boolean }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let ended = false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), left); }),
    ]);
    clearTimeout(timer);
    if (r === "timeout") break;
    if (r.done) { ended = true; break; }
    text += dec.decode(r.value, { stream: true });
  }
  if (!ended) await reader.cancel().catch(() => {});
  return { text, ended };
}
