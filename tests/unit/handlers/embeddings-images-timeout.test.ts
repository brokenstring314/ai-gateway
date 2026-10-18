// Regression: a gateway request timeout on /v1/embeddings and
// /v1/images/generations must answer 504 timeout_error (like
// /v1/chat/completions), not 500.
import { describe, expect, it } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import type { GatewayConfig } from "@/config/types";
import type { IProvider, RequestContext } from "@/providers/types";

/** Waits until the request signal aborts, then rejects the way fetch does. */
function hang(ctx: RequestContext, errName: "AbortError" | "reason"): Promise<never> {
  return new Promise((_, reject) => {
    const signal = ctx.signal;
    if (!signal) return; // never settles: test would time out
    signal.addEventListener("abort", () => {
      reject(errName === "reason" ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}

function hungProvider(errName: "AbortError" | "reason"): IProvider {
  return {
    name: "mock",
    async complete() { throw new Error("unused"); },
    async *completeStream() { throw new Error("unused"); },
    embed: (ctx: RequestContext) => hang(ctx, errName),
    generateImage: (ctx: RequestContext) => hang(ctx, errName),
    supportedModels: () => ["m"],
    supportsModel: (m: string) => m === "m",
    models: () => [{ id: "m", ownedBy: "mock" }],
  } as unknown as IProvider;
}

function setup(errName: "AbortError" | "reason") {
  const cfg = {
    requestTimeout: "1s",
    strategy: { mode: "single", targets: ["mock"] },
    targets: [{ name: "mock", provider: "openai", apiKey: "k", baseURL: "http://127.0.0.1:1/v1", models: ["m"] }],
  } as unknown as GatewayConfig;
  const gw = new Gateway(cfg);
  gw.registerProvider(hungProvider(errName));
  return createApp(gw, cfg);
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("request timeout on embeddings / images", () => {
  for (const errName of ["AbortError", "reason"] as const) {
    it(`returns 504 timeout_error for both routes (provider rejects with ${errName})`, async () => {
      const app = setup(errName);
      const [e, i] = await Promise.all([
        post(app, "/v1/embeddings", { model: "m", input: "x" }),
        post(app, "/v1/images/generations", { model: "m", prompt: "cat" }),
      ]);
      for (const r of [e, i]) {
        expect(r.status).toBe(504);
        const body = await r.json() as { error: { type: string; code: string } };
        expect(body.error.type).toBe("timeout_error");
        expect(body.error.code).toBe("gateway_timeout");
      }
    }, 10_000);
  }
});
