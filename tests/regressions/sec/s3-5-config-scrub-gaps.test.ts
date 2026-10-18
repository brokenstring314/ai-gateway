// S3-5: GET /admin/config (readable by read_only credentials) still leaks
// secrets carried outside the scrubbed fields: MCP args / url, credentials in
// targets[].baseURL (userinfo or ?key=), OTLP endpoint userinfo, and literal
// secrets inside a value that merely starts with "${" and ends with "}".
import { describe, expect, it } from "bun:test";
import { Gateway } from "@/gateway";
import { createApp } from "@/app";
import { cfg, memKeyStore } from "./_h";

describe("S3-5 scrubConfig gaps", () => {
  it.failing("read_only GET /admin/config must not return any secret material", async () => {
    process.env["PFX"] = ""; process.env["SFX"] = "";
    const ks = await memKeyStore();
    const config = cfg({
      adminSecret: "admin-secret-0123456789",
      targets: [
        { name: "g", provider: "openai", apiKey: "", baseURL: "https://u:LEAK_USERINFO@llm.internal/v1?key=LEAK_QUERY_KEY", models: ["gpt-4o"] },
        { name: "t", provider: "openai", apiKey: "${PFX}LEAK_LITERAL_KEY${SFX}", baseURL: "https://up.example/v1", models: ["m2"] },
      ],
      mcpServers: [
        { name: "db", command: "npx", args: ["@mcp/postgres", "postgres://app:LEAK_DB_PASS@db:5432/x", "--api-key", "LEAK_ARG_KEY"] },
      ],
      observability: { tracing: { enabled: false, otlpEndpoint: "https://otel:LEAK_OTLP@collector:4318" } },
    });
    const app = createApp(new Gateway(config), config, undefined, ks, {
      adminSecret: "admin-secret-0123456789", bootstrapReadOnlyKey: "ro-bootstrap-key",
    });
    const r = await app.request("/admin/config", { headers: { authorization: "Bearer ro-bootstrap-key" } });
    expect(r.status).toBe(200);
    const text = await r.text();
    const leaked = ["LEAK_USERINFO", "LEAK_QUERY_KEY", "LEAK_LITERAL_KEY", "LEAK_DB_PASS", "LEAK_ARG_KEY", "LEAK_OTLP"].filter((s) => text.includes(s));
    expect(leaked).toEqual([]); // FAILS: all six leak
  });
});
