// 1.5: one CLI and one bootstrap() for every server entry point.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, type RunningGateway } from "@/server/bootstrap";
import { parseArgs, validateCommand } from "@/cli/index";
import { VERSION } from "@/version";

let running: RunningGateway | undefined;
let dir: string | undefined;
afterEach(async () => {
  await running?.stop("test done");
  running = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function writeConfig(body: string): string {
  dir = mkdtempSync(join(tmpdir(), "agw-boot-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, body);
  return path;
}

const VALID = `
strategy: { mode: single, targets: [a] }
targets:
  - { name: a, provider: openai, apiKey: sk-x, baseURL: "http://127.0.0.1:1/v1", models: [m] }
auth: { enabled: true, keys: ["client-key-123"] }
`;

describe("bootstrap()", () => {
  it("starts the full server: key store, client auth, readiness; stop() drains and closes", async () => {
    const cfg = writeConfig(VALID);
    running = await bootstrap(cfg, { port: 0, host: "127.0.0.1", dataDir: join(dir!, "data"), installSignalHandlers: false });
    const base = `http://127.0.0.1:${running.server.port}`;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
    const ok = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer client-key-123" } });
    expect(ok.status).toBe(200);
    await running.stop();
    expect(running.shutdown.isShuttingDown).toBe(true);
    running = undefined;
  });

  it("throws on an invalid config instead of exiting the process", async () => {
    const cfg = writeConfig("strategy: { mode: least_latency }\ntargets: [{ name: a, provider: openai, apiKey: k }]\n");
    await expect(bootstrap(cfg, { port: 0, dataDir: join(dir!, "data"), installSignalHandlers: false })).rejects.toThrow(
      /least_latency was removed in 0.2.0/,
    );
  });
});

describe("CLI", () => {
  it("parses serve options", () => {
    expect(parseArgs(["serve", "-c", "x.yaml", "-p", "8080", "-h", "0.0.0.0"])).toEqual({
      command: "serve", configPath: "x.yaml", port: 8080, host: "0.0.0.0",
    });
    expect(parseArgs(["serve", "-p", "nope"]).error).toContain("invalid port");
    expect(parseArgs(["serve", "--bogus"]).error).toContain("unknown option");
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("validate prints a summary or the error, returning the exit code", () => {
    const out: string[] = [];
    const sink = { log: (m: string) => out.push(m), error: (m: string) => out.push(m) };
    expect(validateCommand(writeConfig(VALID), sink)).toBe(0);
    expect(out[0]).toContain("valid");
    out.length = 0;
    expect(validateCommand(join(dir!, "missing.yaml"), sink)).toBe(1);
    expect(out.join("\n")).toContain("not found");
  });

  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf-8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
