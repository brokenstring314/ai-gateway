import { describe, it, expect } from "bun:test";
import { scrubConfig } from "@/admin/config-scrub";
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
        type: "stdio",
        command: "mcp-files",
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
    expect(scrubbed.mcpServers![0]!.command).toBe("mcp-files");
  });

  it("does not mutate the input config", () => {
    const original = makeConfig();
    scrubConfig(original);
    expect(original.targets[0]!.apiKey).toBe("sk-plaintext-secret");
    expect(original.adminSecret).toBe("super-secret-admin");
    expect(original.mcpServers![0]!.env!["TOKEN"]).toBe("env-secret-value");
  });

  it("handles missing mcpServers and empty env", () => {
    const config = makeConfig({
      mcpServers: [{ name: "stdio", type: "stdio", command: "npx", env: {} }],
    });
    const scrubbed = scrubConfig(config);
    expect(scrubbed.mcpServers![0]!.env).toEqual({});
  });

  it("preserves nested structures (plugins, aliases, retry)", () => {
    const config = makeConfig({
      plugins: [{ name: "rate-limit", stage: "before_request", config: { rps: 10 } }],
      aliases: { gpt4: "primary" },
    });
    config.targets[0]!.retry = { attempts: 3, onStatusCodes: [429] };
    const scrubbed = scrubConfig(config);
    expect(scrubbed.plugins).toEqual([{ name: "rate-limit", stage: "before_request", config: { rps: 10 } }]);
    expect(scrubbed.aliases).toEqual({ gpt4: "primary" });
    expect(scrubbed.targets[0]!.retry).toEqual({ attempts: 3, onStatusCodes: [429] });
  });
});

describe("scrubConfig — extended secret coverage", () => {
  const cfg = makeConfig({
    auth: { enabled: true, keys: ["sk-gateway-client-key-PLAINTEXT", "${CLIENT_KEY}"] },
    observability: {
      tracing: { enabled: false, headers: { Authorization: "Bearer otlp-SECRET", "x-honeycomb-team": "hc-SECRET" } },
    },
    plugins: [
      {
        name: "webhook",
        stage: "before_request",
        config: { url: "https://hook.example", nested: { apiToken: "plug-SECRET", Cookie: "c-SECRET" }, rps: 5 },
      },
    ],
    mcpServers: [{ name: "m", command: "mcp", env: { API_KEY: "mcp-env-SECRET" } }],
  });

  it("redacts auth.keys, OTLP headers, MCP env and plugin secrets", () => {
    const out = JSON.stringify(scrubConfig(cfg));
    for (const s of ["PLAINTEXT", "otlp-SECRET", "hc-SECRET", "mcp-env-SECRET", "plug-SECRET", "c-SECRET"]) {
      expect(out).not.toContain(s);
    }
  });

  it("keeps non-secret fields and env templates", () => {
    const s = scrubConfig(cfg);
    expect(s.auth!.keys).toEqual(["***", "${CLIENT_KEY}"]);
    expect(s.auth!.enabled).toBe(true);
    expect(s.plugins![0]!.config!["url"]).toBe("https://hook.example");
    expect(s.plugins![0]!.config!["rps"]).toBe(5);
  });
});

describe("S3-5 scrub gaps (3.3)", () => {
  it("read_only GET /admin/config returns no secret material", async () => {
    const { Database } = await import("bun:sqlite");
    const { KeyStore } = await import("@/persistence/key-store");
    const { Gateway } = await import("@/gateway");
    const { createApp } = await import("@/app");
    process.env["PFX"] = "";
    process.env["SFX"] = "";
    try {
      const ks = await KeyStore.create(new Database(":memory:"));
      const config = {
        auth: { enabled: false },
        adminSecret: "admin-secret-0123456789",
        strategy: { mode: "single", targets: ["g"] },
        targets: [
          {
            name: "g",
            provider: "openai",
            apiKey: "k",
            baseURL: "https://u:LEAK_USERINFO@llm.internal/v1?key=LEAK_QUERY_KEY&x=1",
            models: ["gpt-4o"],
          },
          {
            name: "t",
            provider: "openai",
            apiKey: "${PFX}LEAK_LITERAL_KEY${SFX}",
            baseURL: "https://up.example/v1",
            models: ["m2"],
          },
        ],
        mcpServers: [
          {
            name: "db",
            command: "npx",
            args: ["@mcp/postgres", "postgres://app:LEAK_DB_PASS@db:5432/x", "--api-key", "LEAK_ARG_KEY"],
          },
        ],
        observability: { tracing: { enabled: false, otlpEndpoint: "https://otel:LEAK_OTLP@collector:4318" } },
        plugins: [
          {
            name: "x",
            stage: "before_request",
            enabled: false,
            config: { webhook: "https://hook.example/p?token=LEAK_PLUGIN_URL" },
          },
        ],
      } as unknown as GatewayConfig;
      const ro = ks.create("viewer", ["read_only"]).key;
      const app = createApp(new Gateway(config), config, undefined, ks, { adminSecret: "admin-secret-0123456789" });
      const r = await app.request("/admin/config", { headers: { authorization: `Bearer ${ro}` } });
      expect(r.status).toBe(200);
      const text = await r.text();
      const leaked = [
        "LEAK_USERINFO",
        "LEAK_QUERY_KEY",
        "LEAK_LITERAL_KEY",
        "LEAK_DB_PASS",
        "LEAK_ARG_KEY",
        "LEAK_OTLP",
        "LEAK_PLUGIN_URL",
        "admin-secret-0123456789",
      ].filter((s) => text.includes(s));
      expect(leaked).toEqual([]);
      // Non-secret parts survive.
      expect(text).toContain("llm.internal/v1");
      expect(text).toContain("x=1");
      expect(text).toContain("collector:4318");
    } finally {
      delete process.env["PFX"];
      delete process.env["SFX"];
    }
  });

  it("only an exact single ${VAR} counts as a template", () => {
    const s = scrubConfig(
      makeConfig({
        targets: [
          { name: "a", provider: "openai", apiKey: "${OPENAI_KEY}" },
          { name: "b", provider: "openai", apiKey: "${A}sk-literal${B}" },
          { name: "c", provider: "openai", apiKey: "${A} x" },
        ],
      }),
    );
    expect(s.targets.map((t) => t.apiKey)).toEqual(["${OPENAI_KEY}", "***", "***"]);
  });

  it("scrubUrl: userinfo and sensitive query values only", async () => {
    const { scrubUrl } = await import("@/admin/config-scrub");
    expect(scrubUrl("https://user:pw@h/v1")).toBe("https://***@h/v1");
    expect(scrubUrl("https://tok@h/v1")).toBe("https://***@h/v1");
    expect(scrubUrl("https://h/v1?api_key=s&sig=s2&model=m")).toBe("https://h/v1?api_key=***&sig=***&model=m");
    expect(scrubUrl("https://h/v1?key=${GEMINI_KEY}")).toBe("https://h/v1?key=${GEMINI_KEY}");
    expect(scrubUrl("http://localhost:${PORT}/v1")).toBe("http://localhost:${PORT}/v1");
    expect(scrubUrl("${BASE_URL}")).toBe("${BASE_URL}");
  });

  it("redacts every MCP arg", () => {
    const s = scrubConfig(makeConfig({ mcpServers: [{ name: "m", command: "npx", args: ["pkg", "--token", "t"] }] }));
    expect(s.mcpServers![0]!.args).toEqual(["***", "***", "***"]);
    expect(s.mcpServers![0]!.command).toBe("npx");
  });
});
