// `ai-gateway keys create|list|revoke`: direct key-store management / admin recovery.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { keysCommand, parseKeysArgs } from "@/cli/keys";
import { usage } from "@/cli/index";
import { KeyStore, keyStorePath, openKeyStoreDatabase } from "@/persistence/key-store";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CONFIG = `
strategy: { mode: single, targets: [a] }
targets:
  - { name: a, provider: openai, apiKey: sk-upstream-secret-value, baseURL: "http://127.0.0.1:1/v1", models: [m] }
adminSecret: admin-secret-must-not-print
`;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Config file + data dir with an initialised (empty) key store. */
async function setup(): Promise<{ cfg: string; dataDir: string }> {
  dir = mkdtempSync(join(tmpdir(), "agw-keys-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, CONFIG);
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  (await KeyStore.create(openKeyStoreDatabase(keyStorePath(dataDir)))).close();
  return { cfg, dataDir };
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await keysCommand(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, all: [...out, ...err].join("\n") };
}

async function openStore(dataDir: string) {
  return KeyStore.create(openKeyStoreDatabase(keyStorePath(dataDir)));
}

describe("parseKeysArgs", () => {
  it("parses subcommands and options", () => {
    const p = parseKeysArgs(["create", "--admin", "--name", "ops", "--expires", "2030-01-01", "-c", "x.yaml"]);
    expect(p).toMatchObject({ sub: "create", admin: true, name: "ops", expires: "2030-01-01", configPath: "x.yaml" });
    expect(parseKeysArgs(["revoke", "abc", "-c", "x"]).id).toBe("abc");
    expect(parseKeysArgs(["create", "--bogus"]).error).toContain("unknown option");
    expect(parseKeysArgs(["create", "--name"]).error).toContain("needs a value");
    expect(parseKeysArgs(["list", "extra"]).error).toContain("unexpected argument");
  });
});

describe("ai-gateway keys", () => {
  it("create --admin prints the key once on stdout only; it authenticates as admin", async () => {
    const { cfg, dataDir } = await setup();
    const r = await run(["create", "--admin", "--name", "recovery", "-c", cfg, "--data-dir", dataDir]);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    const key = r.out[0]!;
    expect(key.length).toBeGreaterThan(20);
    expect(r.err.join("\n")).not.toContain(key);
    expect(r.err.join("\n")).toContain("recovery");
    expect(r.all).not.toContain("sk-upstream-secret-value");
    expect(r.all).not.toContain("admin-secret-must-not-print");

    const store = await openStore(dataDir);
    const k = store.validateKey(key);
    expect(k?.scopes).toEqual(["admin"]);
    expect(k?.name).toBe("recovery");
    expect(store.isBootstrapLatched()).toBe(true);
    store.close();
  });

  it("create --json, --expires, --read-only and the inference default", async () => {
    const { cfg, dataDir } = await setup();
    const r = await run([
      "create",
      "--read-only",
      "--json",
      "--expires",
      "2099-01-01T00:00:00Z",
      "-c",
      cfg,
      "--data-dir",
      dataDir,
    ]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out[0]!) as { key: string; scopes: string[]; expiresAt: string; name: string };
    expect(j.scopes).toEqual(["read_only"]);
    expect(j.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(j.name).toBe("cli-read-only");
    const plain = await run(["create", "-c", cfg, "--data-dir", dataDir]);
    const store = await openStore(dataDir);
    expect(store.validateKey(j.key)?.scopes).toEqual(["read_only"]);
    expect(store.validateKey(plain.out[0]!)?.scopes).toEqual(["inference"]);
    expect(store.isBootstrapLatched()).toBe(false);
    store.close();
  });

  it("list shows keys without secrets; revoke disables a key", async () => {
    const { cfg, dataDir } = await setup();
    const created = await run(["create", "--admin", "--json", "-c", cfg, "--data-dir", dataDir]);
    const { id, key } = JSON.parse(created.out[0]!) as { id: string; key: string };

    const list = await run(["list", "-c", cfg, "--data-dir", dataDir]);
    expect(list.code).toBe(0);
    expect(list.out.join("\n")).toContain(id);
    expect(list.all).not.toContain(key);
    expect(list.err.join("\n")).toContain("bootstrap latch: set at");

    expect((await run(["revoke", id, "-c", cfg, "--data-dir", dataDir])).code).toBe(0);
    const json = await run(["list", "--json", "-c", cfg, "--data-dir", dataDir]);
    const parsed = JSON.parse(json.out.join("\n")) as {
      keys: Array<{ id: string; status: string }>;
      bootstrapLatchedAt: string | null;
    };
    expect(parsed.keys.find((k) => k.id === id)?.status).toBe("revoked");
    expect(parsed.bootstrapLatchedAt).not.toBeNull();
    expect(json.all).not.toContain(key);

    const store = await openStore(dataDir);
    expect(store.validateKey(key)).toBeNull();
    store.close();

    const missing = await run(["revoke", "nope", "-c", cfg, "--data-dir", dataDir]);
    expect(missing.code).toBe(1);
    expect(missing.err.join("\n")).toContain("no key with id nope");
  });

  it("uses GATEWAY_DATA_DIR when --data-dir is not given", async () => {
    const { cfg, dataDir } = await setup();
    const prev = process.env["GATEWAY_DATA_DIR"];
    process.env["GATEWAY_DATA_DIR"] = dataDir;
    try {
      expect((await run(["create", "--admin", "-c", cfg])).code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env["GATEWAY_DATA_DIR"];
      else process.env["GATEWAY_DATA_DIR"] = prev;
    }
    const store = await openStore(dataDir);
    expect(store.list()).toHaveLength(1);
    store.close();
  });

  it("errors: missing config, invalid config, missing store, bad expiry, bad subcommand", async () => {
    const { cfg, dataDir } = await setup();
    expect((await run(["create", "--admin"])).err.join("\n")).toContain("-c/--config is required");
    const bad = join(dir!, "bad.yaml");
    writeFileSync(bad, "strategy: { mode: least_latency }\ntargets: [{ name: a, provider: openai, apiKey: k }]\n");
    const invalid = await run(["create", "--admin", "-c", bad, "--data-dir", dataDir]);
    expect(invalid.code).toBe(1);
    expect(invalid.err.join("\n")).toContain("invalid");

    const nowhere = await run(["create", "--admin", "-c", cfg, "--data-dir", join(dir!, "elsewhere")]);
    expect(nowhere.code).toBe(1);
    expect(nowhere.err.join("\n")).toContain("no API key store");

    expect((await run(["create", "--expires", "yesterday", "-c", cfg, "--data-dir", dataDir])).code).toBe(1);
    const past = await run(["create", "--expires", "2001-01-01T00:00:00Z", "-c", cfg, "--data-dir", dataDir]);
    expect(past.err.join("\n")).toContain("in the past");
    expect((await run(["frobnicate", "-c", cfg])).code).toBe(1);
    expect((await run([])).code).toBe(1);
    expect((await run(["--help"])).out.join("\n")).toContain("keys create");

    const store = await openStore(dataDir);
    expect(store.list()).toHaveLength(0);
    store.close();
  });

  it("works while another connection (a running server) holds the database", async () => {
    const { cfg, dataDir } = await setup();
    const server = await openStore(dataDir);
    server.create("client", ["inference"]);
    const r = await run(["create", "--admin", "-c", cfg, "--data-dir", dataDir]);
    expect(r.code).toBe(0);
    expect(server.validateKey(r.out[0]!)?.scopes).toEqual(["admin"]);
    expect(server.isBootstrapLatched()).toBe(true);
    server.close();
  });

  it("the real binary: `ai-gateway keys create --admin` exits 0 and prints only the key on stdout", async () => {
    const { cfg, dataDir } = await setup();
    const proc = Bun.spawn([process.execPath, "src/index.ts", "keys", "create", "--admin", "-c", cfg], {
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
    expect(code).toBe(0);
    const key = stdout.trim();
    expect(key.split("\n")).toHaveLength(1);
    expect(stderr).not.toContain(key);
    const store = await openStore(dataDir);
    expect(store.validateKey(key)?.scopes).toEqual(["admin"]);
    store.close();
  });

  it("top-level help documents the keys command and recovery", () => {
    const u = usage();
    expect(u).toContain("ai-gateway keys create");
    expect(u).toContain("keys list");
    expect(u).toContain("keys revoke");
    expect(u).toContain("recovery");
  });
});
