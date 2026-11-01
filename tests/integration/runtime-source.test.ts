/**
 * Startup config resolution (0.3.0 P1): first start imports the file into
 * the config store; later starts use the store; source: file keeps 0.2.0
 * behaviour; a gateway built from the store routes exactly like one built
 * from the file, with the decrypted upstream key on the wire.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configCommand } from "../../src/cli/config.js";
import { loadConfigFromObject } from "../../src/config/loader.js";
import { resolveRuntimeConfig } from "../../src/config/runtime-source.js";
import { Gateway } from "../../src/gateway.js";
import type { ChatCompletionRequest, RequestContext } from "../../src/providers/types.js";

const SECRET = "sk-upstream-literal-secret-9999";
const seenAuth: string[] = [];
const up = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    seenAuth.push(req.headers.get("authorization") ?? "");
    return Response.json({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content: new URL(req.url).pathname }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});
afterAll(() => up.stop(true));

let savedNoProxy: string | undefined;
beforeAll(() => {
  savedNoProxy = process.env["NO_PROXY"];
  process.env["NO_PROXY"] = "127.0.0.1,localhost";
});
afterAll(() => {
  if (savedNoProxy === undefined) delete process.env["NO_PROXY"];
  else process.env["NO_PROXY"] = savedNoProxy;
});

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rtsrc-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ENV = { GATEWAY_SECRET_KEY: "ab".repeat(32) };

function raw(targetName: string, extra: Record<string, unknown> = {}) {
  return {
    strategy: { mode: "single", targets: [targetName] },
    targets: [
      {
        name: targetName,
        provider: "openai",
        apiKey: SECRET,
        baseURL: `http://127.0.0.1:${up.port}/v1`,
        models: ["m"],
      },
    ],
    aliases: { short: "m" },
    server: { port: 1234 },
    ...extra,
  };
}

describe("resolveRuntimeConfig", () => {
  it("imports on first start, then uses the store and warns when the file changed", async () => {
    const dir = tempDir();
    const first = await resolveRuntimeConfig(loadConfigFromObject(raw("one")), dir, { env: ENV });
    expect(first.source).toBe("database");
    expect(first.imported).toBe(true);
    expect(first.config.targets[0]?.name).toBe("one");
    first.store?.close();

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const second = await resolveRuntimeConfig(loadConfigFromObject(raw("two", { server: { port: 5678 } })), dir, {
      env: ENV,
    });
    expect(second.imported).toBe(false);
    // Runtime sections from the store, startup sections from the new file.
    expect(second.config.targets[0]?.name).toBe("one");
    expect(second.config.server?.port).toBe(5678);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("IGNORED"))).toBe(true);
    second.store?.close();
  });

  it("does not warn when only startup sections changed", async () => {
    const dir = tempDir();
    (await resolveRuntimeConfig(loadConfigFromObject(raw("one")), dir, { env: ENV })).store?.close();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveRuntimeConfig(loadConfigFromObject(raw("one", { server: { port: 9 } })), dir, { env: ENV });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("IGNORED"))).toBe(false);
    r.store?.close();
  });

  it("source: file uses the file and opens no store", async () => {
    const dir = tempDir();
    const r = await resolveRuntimeConfig(loadConfigFromObject(raw("one", { runtimeConfig: { source: "file" } })), dir, {
      env: {},
    });
    expect(r.source).toBe("file");
    expect(r.store).toBeUndefined();
  });

  it("refuses production without GATEWAY_SECRET_KEY", async () => {
    await expect(
      resolveRuntimeConfig(loadConfigFromObject(raw("one")), tempDir(), { env: { GATEWAY_ENV: "production" } }),
    ).rejects.toThrow(/requires GATEWAY_SECRET_KEY/);
  });

  it("refuses to import a literal key without GATEWAY_SECRET_KEY (nothing half-written)", async () => {
    const dir = tempDir();
    await expect(resolveRuntimeConfig(loadConfigFromObject(raw("one")), dir, { env: {} })).rejects.toThrow(
      /requires GATEWAY_SECRET_KEY/,
    );
    const r = await resolveRuntimeConfig(loadConfigFromObject(raw("one")), dir, { env: ENV });
    expect(r.imported).toBe(true);
    r.store?.close();
  });

  it("a gateway from the store routes like one from the file, sending the decrypted key", async () => {
    const file = loadConfigFromObject(raw("one"));
    const r = await resolveRuntimeConfig(file, tempDir(), { env: ENV });
    const ctx = { metadata: {} } as RequestContext;
    const req = { model: "short", messages: [{ role: "user", content: "hi" }] } as ChatCompletionRequest;
    seenAuth.length = 0;
    const fromFile = await new Gateway(file).route(ctx, req);
    const fromStore = await new Gateway(r.config).route({ metadata: {} } as RequestContext, req);
    expect(fromStore.choices[0]?.message).toEqual(fromFile.choices[0]?.message);
    expect(fromStore.provider).toBe(fromFile.provider);
    expect(seenAuth).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
    r.store?.close();
  });
});

describe("ai-gateway config", () => {
  function run(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    return configCommand(args, { out: (l) => out.push(l), err: (l) => err.push(l) }).then((code) => ({
      code,
      out,
      err,
    }));
  }

  it("import refuses an initialized store unless --force; status shows hints, never keys", async () => {
    const dir = tempDir();
    const cfgJson = join(dir, "c.json");
    writeFileSync(cfgJson, JSON.stringify(raw("one")));
    const data = join(dir, "data");

    const first = await run(["import", "-c", cfgJson, "--data-dir", data]);
    expect(first.code).toBe(0);
    const again = await run(["import", "-c", cfgJson, "--data-dir", data]);
    expect(again.code).toBe(1);
    expect(again.err.join("\n")).toContain("--force");
    const forced = await run(["import", "--force", "-c", cfgJson, "--data-dir", data]);
    expect(forced.code).toBe(0);
    expect(forced.out.join("\n")).toContain("version 2");

    const status = await run(["status", "-c", cfgJson, "--data-dir", data]);
    expect(status.code).toBe(0);
    const text = status.out.join("\n");
    expect(text).toContain("sk-…9999");
    expect(text).not.toContain(SECRET);
    const json = await run(["status", "--json", "-c", cfgJson, "--data-dir", data]);
    expect(json.out.join("\n")).not.toContain(SECRET);
  });
});
