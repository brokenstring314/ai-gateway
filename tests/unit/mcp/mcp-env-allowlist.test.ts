// S3-3 regression: MCP stdio servers must not inherit the gateway's whole
// environment (provider keys, ADMIN_BOOTSTRAP_KEY, ...).
import { afterEach, describe, expect, it } from "bun:test";
import { buildMcpEnv, defaultSpawner } from "@/mcp/client";
import { McpServerConfigSchema } from "@/config/schema";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["ADMIN_BOOTSTRAP_KEY", "OPENAI_API_KEY", "EXTRA_VAR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("S3-3 MCP subprocess env", () => {
  it("spawned server does not receive unrelated gateway secrets", async () => {
    process.env["ADMIN_BOOTSTRAP_KEY"] = "bootstrap-SECRET-123";
    process.env["OPENAI_API_KEY"] = "sk-OPERATOR-SECRET";
    const proc = defaultSpawner({ name: "x", command: "sh", args: ["-c", "env"], env: { ONLY_THIS: "1" } });
    const out = await new Response(proc.stdout as ReadableStream).text();
    expect(out).toContain("ONLY_THIS=1");
    expect(out).toContain("PATH=");
    expect({ bootstrapLeaked: out.includes("bootstrap-SECRET-123"), providerKeyLeaked: out.includes("sk-OPERATOR-SECRET") })
      .toEqual({ bootstrapLeaked: false, providerKeyLeaked: false });
  });

  it("allowlist + config.env; config.env wins", () => {
    const env = buildMcpEnv(
      { env: { HOME: "/override", TOKEN: "t" } },
      { PATH: "/bin", HOME: "/root", LANG: "C.UTF-8", OPENAI_API_KEY: "sk-x", AWS_SECRET_ACCESS_KEY: "a" },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/override", LANG: "C.UTF-8", TOKEN: "t" });
  });

  it("inheritEnv list adds named variables only", () => {
    const env = buildMcpEnv({ inheritEnv: ["EXTRA_VAR"] }, { PATH: "/bin", EXTRA_VAR: "1", OPENAI_API_KEY: "sk" });
    expect(env).toEqual({ PATH: "/bin", EXTRA_VAR: "1" });
  });

  it("inheritEnv: true restores full inheritance (opt-in)", () => {
    const env = buildMcpEnv({ inheritEnv: true, env: { A: "b" } }, { PATH: "/bin", OPENAI_API_KEY: "sk" });
    expect(env).toEqual({ PATH: "/bin", OPENAI_API_KEY: "sk", A: "b" });
  });

  it("schema accepts inheritEnv as boolean or string list", () => {
    expect(McpServerConfigSchema.safeParse({ name: "a", command: "x", inheritEnv: true }).success).toBe(true);
    expect(McpServerConfigSchema.safeParse({ name: "a", command: "x", inheritEnv: ["A"] }).success).toBe(true);
    expect(McpServerConfigSchema.safeParse({ name: "a", command: "x", inheritEnv: "yes" }).success).toBe(false);
  });
});
