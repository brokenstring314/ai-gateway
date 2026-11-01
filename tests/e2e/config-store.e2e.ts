/**
 * Contract (0.3.0 P1): the runtime config lives in <data dir>/config.sqlite.
 * The first start imports the file; a restart with a changed file keeps
 * serving the stored config (and says so); upstream keys are stored
 * encrypted and the server refuses to start without the key to decrypt them.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseConfig, startGateway } from "./harness/gateway";
import { type MockUpstream, startMockUpstream } from "./harness/mock-upstream";

let upA: MockUpstream;
let upB: MockUpstream;
let dataDir: string;

beforeAll(() => {
  upA = startMockUpstream("A");
  upB = startMockUpstream("B");
  dataDir = mkdtempSync(join(tmpdir(), "aigw-e2e-store-"));
});
afterAll(() => {
  upA.stop();
  upB.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function chat(gw: Awaited<ReturnType<typeof startGateway>>) {
  return gw.fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("config store", () => {
  it("imports on first start, keeps the stored config on restart, never stores the key in plaintext", async () => {
    const gw1 = await startGateway({ config: baseConfig([{ name: "a", mock: upA }]), dataDir });
    expect(gw1.logs()).toContain("[config] imported 1 target(s)");
    expect((await chat(gw1)).status).toBe(200);
    expect(upA.requests.at(-1)?.headers["authorization"]).toBe("Bearer sk-upstream-a");
    await gw1.stop();

    for (const f of readdirSync(dataDir).filter((n) => n.startsWith("config.sqlite"))) {
      expect(readFileSync(join(dataDir, f)).toString("latin1")).not.toContain("sk-upstream-a");
    }

    // Same data dir, file now points at B: the stored config (A) still serves.
    const before = upB.requests.length;
    const gw2 = await startGateway({ config: baseConfig([{ name: "b", mock: upB }]), dataDir });
    expect(gw2.logs()).toContain("IGNORED");
    expect((await chat(gw2)).status).toBe(200);
    expect(upB.requests.length).toBe(before);
    expect(upA.requests.at(-1)?.headers["authorization"]).toBe("Bearer sk-upstream-a");
    await gw2.stop();
  });

  it("refuses to start without GATEWAY_SECRET_KEY when it must store or read an encrypted key", async () => {
    await expect(
      startGateway({
        config: baseConfig([{ name: "a", mock: upA }]),
        env: { GATEWAY_SECRET_KEY: "" },
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/GATEWAY_SECRET_KEY/);
  });

  it("runtimeConfig.source: file reads the file and creates no store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aigw-e2e-file-"));
    try {
      const gw = await startGateway({
        config: baseConfig([{ name: "a", mock: upA }], { runtimeConfig: { source: "file" } }),
        env: { GATEWAY_SECRET_KEY: "" },
        dataDir: dir,
      });
      expect((await chat(gw)).status).toBe(200);
      await gw.stop();
      expect(readdirSync(dir).some((n) => n.startsWith("config.sqlite"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
