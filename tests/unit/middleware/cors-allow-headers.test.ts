/**
 * B3-8: CORS preflight must allow the headers official SDKs send
 * (x-stainless-*, openai-organization/project/beta). Default reflects
 * Access-Control-Request-Headers; cors.allowHeaders restricts it.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { parseConfig } from "@/config/schema";
import { KeyStore } from "@/persistence/key-store";
import type { GatewayConfig } from "@/config/types";

const SDK_HEADERS = [
  "authorization",
  "content-type",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "openai-organization",
  "openai-project",
  "openai-beta",
];

function makeConfig(cors: GatewayConfig["cors"]): GatewayConfig {
  return {
    strategy: { mode: "single", targets: ["mock"] },
    targets: [
      { name: "mock", provider: "openai", apiKey: "sk-x", baseURL: "https://upstream.example/v1", models: ["gpt-4o"] },
    ],
    adminSecret: "test-admin-secret-1234",
    cors,
  };
}

async function preflight(config: GatewayConfig, requestHeaders: string) {
  const keyStore = await KeyStore.create(new Database(":memory:"));
  const app = createApp(new Gateway(config), config, undefined, keyStore, { adminSecret: config.adminSecret });
  return app.request("/v1/chat/completions", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": requestHeaders,
    },
  });
}

describe("CORS allowHeaders (B3-8)", () => {
  it("reflects Access-Control-Request-Headers by default (openai SDK preflight passes)", async () => {
    const res = await preflight(
      makeConfig({ enabled: true, origins: ["https://app.example.com"] }),
      SDK_HEADERS.join(","),
    );
    expect(res.status).toBe(204);
    const allow = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/);
    for (const h of SDK_HEADERS) expect(allow).toContain(h);
    expect(res.headers.get("vary") ?? "").toContain("Access-Control-Request-Headers");
  });

  it("uses an explicit cors.allowHeaders list when configured", async () => {
    const res = await preflight(
      makeConfig({ enabled: true, origins: ["*"], allowHeaders: ["Content-Type", "Authorization"] }),
      "authorization,x-stainless-os",
    );
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type,Authorization");
  });

  it("schema accepts cors.allowHeaders", () => {
    const parsed = parseConfig({ ...makeConfig({ enabled: true, allowHeaders: ["X-A"] }) });
    expect(parsed.cors?.allowHeaders).toEqual(["X-A"]);
  });
});
