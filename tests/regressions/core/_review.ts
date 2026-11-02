/**
 * Shared helpers for the 2026-11-02 core review regressions (C4, C7).
 */
import { loadConfigFromObject } from "@/config/loader";
import { Gateway } from "@/gateway";
import type { RequestLogEntry } from "@/observability/request-log";

export type Handler = (url: URL, init: RequestInit | undefined, body: any) => Response | Promise<Response>;

/** Replace global fetch for hosts ending in .upstream.test; returns uninstall + recorded calls. */
export function fakeFetch(handler: Handler) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith(".upstream.test")) return original(input as never, init);
    const b = init?.body as unknown;
    const text =
      typeof b === "string"
        ? b
        : b instanceof ArrayBuffer || ArrayBuffer.isView(b)
          ? new TextDecoder().decode(b as ArrayBuffer)
          : "";
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    calls.push({ url: url.toString(), body });
    return handler(url, init, body);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

export function target(name: string, models: string[] = ["m"], extra: Record<string, unknown> = {}) {
  return {
    name,
    provider: "openai",
    apiKey: `sk-test-${name}-0123456789`,
    baseURL: `https://${name}.upstream.test/v1`,
    models,
    ...extra,
  };
}

export function makeGateway(file: Record<string, unknown>) {
  const config = loadConfigFromObject(file);
  const gw = new Gateway(config);
  const logs: RequestLogEntry[] = [];
  gw.addRequestLogSink((e) => logs.push(e));
  return { gw, logs };
}

export function chatJson(content: string, usage?: Record<string, number>) {
  return Response.json({
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage ? { usage } : {}),
  });
}

export function sse(events: unknown[], done = true): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

export function chunk(content: string, finish: string | null = null) {
  return {
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }],
  };
}

export const meteredClient = (id: string, quotaTokens: number | null = null) => ({
  id,
  limits: { quotaTokens, rpm: null, tpm: null },
});
