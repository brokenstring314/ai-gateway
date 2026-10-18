/**
 * Contract: ADMIN_BOOTSTRAP_KEY is a one-shot credential. Once the first admin
 * key exists it is refused for good (also after that key is revoked), and
 * admin access is recovered with `ai-gateway keys create --admin` against the
 * running gateway's key store.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, startGateway, type GatewayProcess } from "./harness/gateway";
import { startMockUpstream, type MockUpstream } from "./harness/mock-upstream";

const BOOT = "e2e-bootstrap-admin-key-0123456789";

let up: MockUpstream;
let gw: GatewayProcess | undefined;
let dataDir: string;

function config() {
  return {
    strategy: { mode: "single", targets: ["a"] },
    targets: [{ name: "a", provider: "openai", apiKey: "sk-upstream-a", baseURL: up.url, models: ["gpt-4o"] }],
    // Auth on, no adminSecret, no auth.keys: only the bootstrap key can get in.
    auth: { enabled: true },
    requestTimeout: "10s",
  };
}

async function cliKeys(args: string[], cfgPath: string) {
  const proc = Bun.spawn([process.execPath, "src/index.ts", "keys", ...args, "-c", cfgPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, GATEWAY_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

beforeAll(async () => {
  up = startMockUpstream("a");
  dataDir = join(mkdtempSync(join(tmpdir(), "aigw-e2e-latch-")), "data");
  gw = await startGateway({ config: config(), env: { ADMIN_BOOTSTRAP_KEY: BOOT }, dataDir });
});
afterAll(async () => {
  await gw?.stop();
  up?.stop();
  rmSync(join(dataDir, ".."), { recursive: true, force: true });
});

describe("bootstrap latch + CLI recovery", () => {
  it("bootstrap → admin key → revoke → bootstrap still 401 → CLI admin key works", async () => {
    const g = gw!;
    expect(g.logs()).toContain("ADMIN_BOOTSTRAP_KEY is active");
    expect((await g.fetch("/admin/keys", { auth: BOOT })).status).toBe(200);

    const created = await g.fetch("/admin/keys", {
      method: "POST",
      auth: BOOT,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "first-admin", scopes: ["admin"] }),
    });
    expect(created.status).toBe(201);
    const first = (await created.json()) as { id: string; key: string };
    expect((await g.fetch("/admin/keys", { auth: BOOT })).status).toBe(401);
    expect((await g.fetch("/admin/keys", { auth: first.key })).status).toBe(200);

    const revoked = await g.fetch(`/admin/keys/${first.id}/revoke`, { method: "POST", auth: first.key });
    expect(revoked.status).toBe(200);
    expect((await g.fetch("/admin/keys", { auth: first.key })).status).toBe(401);

    // No admin key is usable any more, and the bootstrap key stays refused.
    const boot = await g.fetch("/admin/keys", { auth: BOOT });
    expect(boot.status).toBe(401);
    expect(((await boot.json()) as { error: { code: string } }).error.code).toBe("invalid_admin_secret");
    expect((await g.fetch("/v1/models", { auth: BOOT })).status).toBe(401);
    expect(g.logs()).toContain("permanently disabled");

    // Recovery with the server running.
    const cli = await cliKeys(["create", "--admin", "--name", "recovered"], g.configPath);
    expect(cli.code).toBe(0);
    const key = cli.stdout.trim();
    expect(cli.stderr).not.toContain(key);
    expect(g.logs()).not.toContain(key);
    const list = await g.fetch("/admin/keys", { auth: key });
    expect(list.status).toBe(200);
    const names = ((await list.json()) as { keys: Array<{ name: string }> }).keys.map((k) => k.name);
    expect(names).toContain("recovered");
    expect((await g.fetch("/v1/models", { auth: key })).status).toBe(200);
    expect((await g.fetch("/admin/keys", { auth: BOOT })).status).toBe(401);

    // CLI list/revoke against the running server.
    const ls = await cliKeys(["list", "--json"], g.configPath);
    expect(ls.code).toBe(0);
    expect(ls.stdout).not.toContain(key);
    const recovered = (JSON.parse(ls.stdout) as { keys: Array<{ id: string; name: string }> }).keys.find(
      (k) => k.name === "recovered",
    )!;
    expect((await cliKeys(["revoke", recovered.id], g.configPath)).code).toBe(0);
    expect((await g.fetch("/admin/keys", { auth: key })).status).toBe(401);
  });

  it("restart with ADMIN_BOOTSTRAP_KEY still set: refused, one startup warning to remove it", async () => {
    await gw!.stop();
    gw = await startGateway({ config: config(), env: { ADMIN_BOOTSTRAP_KEY: BOOT }, dataDir });
    await Bun.sleep(200); // let the stdout/stderr pumps catch up
    const logs = gw.logs();
    expect(logs).not.toContain("ADMIN_BOOTSTRAP_KEY is active");
    expect(logs.match(/permanently disabled/g)?.length).toBe(1);
    expect(logs).toContain("remove them from the environment");
    expect(logs).not.toContain(BOOT);
    expect((await gw.fetch("/admin/keys", { auth: BOOT })).status).toBe(401);
    expect(gw.logs().match(/permanently disabled/g)?.length).toBe(1);
  });
});
