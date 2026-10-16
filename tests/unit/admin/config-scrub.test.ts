import { describe, it, expect } from "bun:test";
import { scrubConfig, scrubConfigJson } from "@/admin/config-scrub";
import type { GatewayConfig } from "@/config/types";

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    apiVersion: "v1",
    strategy: { mode: "fallback", targets: ["primary"] },
    targets: [
      {
        name: "primary",
        provider: "openai",
        apiKey: "sk-plaintext-secret",
        baseURL: "https://api.openai.com/v1",
        weight: 1,
      },
    ],
    server: { port: 3000, host: "0.0.0.0" },
    adminSecret: "super-secret-admin",
    mcpServers: [
      {
        name: "files",
        type: "http",
        url: "https://mcp.example.com",
        headers: { Authorization: "Bearer mcp-token", "X-Custom": "keep-me" },
        env: { TOKEN: "env-secret-value", MODE: "prod" },
      },
    ],
    ...overrides,
  };
}

describe("scrubConfig", () => {
  it("redacts plaintext apiKey to ***", () => {
    const scrubbed = scrubConfig(makeConfig());
    expect(scrubbed.targets[0]!.apiKey).toBe("***");
  });

  it("preserves ${VAR} apiKey templates", () => {
    const config = makeConfig({
      targets: [{ name: "primary", provider: "openai", apiKey: "${OPENAI_API_KEY}" }],
    });
    expect(scrubConfig(config).targets[0]!.apiKey).toBe("${OPENAI_API_KEY}");
  });

  it("redacts adminSecret to ***", () => {
    expect(scrubConfig(makeConfig()).adminSecret).toBe("***");
  });

  it("leaves adminSecret undefined when absent", () => {
    const config = makeConfig();
    delete config.adminSecret;
    expect(scrubConfig(config).adminSecret).toBeUndefined();
  });

  it("redacts MCP headers Authorization but keeps other headers", () => {
    const scrubbed = scrubConfig(makeConfig());
    expect(scrubbed.mcpServers![0]!.headers!["Authorization"]).toBe("***");
    expect(scrubbed.mcpServers![0]!.headers!["X-Custom"]).toBe("keep-me");
  });

  it("redacts all MCP env values but keeps keys", () => {
    const scrubbed = scrubConfig(makeConfig());
    expect(scrubbed.mcpServers![0]!.env).toEqual({ TOKEN: "***", MODE: "***" });
  });

  it("preserves non-sensitive fields", () => {
    const scrubbed = scrubConfig(makeConfig());
    expect(scrubbed.apiVersion).toBe("v1");
    expect(scrubbed.strategy).toEqual({ mode: "fallback", targets: ["primary"] });
    expect(scrubbed.server).toEqual({ port: 3000, host: "0.0.0.0" });
    expect(scrubbed.targets[0]!.name).toBe("primary");
    expect(scrubbed.targets[0]!.baseURL).toBe("https://api.openai.com/v1");
    expect(scrubbed.targets[0]!.weight).toBe(1);
    expect(scrubbed.mcpServers![0]!.url).toBe("https://mcp.example.com");
  });

  it("does not mutate the input config", () => {
    const original = makeConfig();
    scrubConfig(original);
    expect(original.targets[0]!.apiKey).toBe("sk-plaintext-secret");
    expect(original.adminSecret).toBe("super-secret-admin");
    expect(original.mcpServers![0]!.headers!["Authorization"]).toBe("Bearer mcp-token");
    expect(original.mcpServers![0]!.env!["TOKEN"]).toBe("env-secret-value");
  });

  it("handles missing mcpServers and empty env/headers", () => {
    const config = makeConfig({
      mcpServers: [{ name: "stdio", type: "stdio", command: "npx", env: {}, headers: {} }],
    });
    const scrubbed = scrubConfig(config);
    expect(scrubbed.mcpServers![0]!.env).toEqual({});
    expect(scrubbed.mcpServers![0]!.headers).toEqual({});
  });

  it("preserves nested structures (plugins, aliases, retry)", () => {
    const config = makeConfig({
      plugins: [{ name: "rate-limit", stage: "before_request", config: { rps: 10 } }],
      aliases: { gpt4: "primary" },
    });
    config.targets[0]!.retry = { attempts: 3, onStatusCodes: [429] };
    const scrubbed = scrubConfig(config);
    expect(scrubbed.plugins).toEqual([
      { name: "rate-limit", stage: "before_request", config: { rps: 10 } },
    ]);
    expect(scrubbed.aliases).toEqual({ gpt4: "primary" });
    expect(scrubbed.targets[0]!.retry).toEqual({ attempts: 3, onStatusCodes: [429] });
  });

  it("scrubConfigJson round-trips through scrubConfig", () => {
    const original = makeConfig();
    const roundTripped = JSON.parse(scrubConfigJson(JSON.stringify(original))) as GatewayConfig;
    expect(roundTripped).toEqual(scrubConfig(original));
  });

  it("scrubConfigJson never contains plaintext secrets", () => {
    const json = scrubConfigJson(JSON.stringify(makeConfig()));
    expect(json).not.toContain("sk-plaintext-secret");
    expect(json).not.toContain("super-secret-admin");
    expect(json).not.toContain("env-secret-value");
    expect(json).toContain("***");
  });
});
