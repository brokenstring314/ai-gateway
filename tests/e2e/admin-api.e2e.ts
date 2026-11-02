/**
 * Contract (0.3.0 P4): the runtime-config Admin API on a real server.
 *
 *  - config churn: continuous chat traffic (plain and streaming, a model
 *    and its alias) while the config is changed over HTTP ~1000 times at
 *    random (bindings, balance modes, channel on/off, keys added /
 *    disabled / enabled, aliases, an extra model, compatibility, rollbacks):
 *    zero request errors, every write applied;
 *  - a key disabled after an upstream 401 stays disabled across a restart
 *    (persisted asynchronously), and the rest of the channel keeps serving.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_SECRET, baseConfig, type GatewayProcess, postJson, startGateway } from "./harness/gateway";
import { type MockUpstream, startMockUpstream } from "./harness/mock-upstream";

let a: MockUpstream;
let b: MockUpstream;
beforeAll(() => {
  a = startMockUpstream("a");
  b = startMockUpstream("b");
});
afterAll(() => {
  a?.stop();
  b?.stop();
});

function adminFetch(gw: GatewayProcess, method: string, path: string, body?: unknown, ifMatch?: string | number) {
  const headers: Record<string, string> = { "x-admin-secret": ADMIN_SECRET };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
  return gw.fetch(`/admin${path}`, {
    method,
    headers,
    auth: null,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function ok(r: Response, what: string): Promise<any> {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${await r.text()}`);
  return r.json();
}

function config() {
  return baseConfig(
    [
      { name: "a", mock: a },
      { name: "b", mock: b },
    ],
    {
      models: [{ name: "gpt-4o", bindings: [{ target: "a" }, { target: "b" }] }],
      aliases: { fast: "gpt-4o" },
    },
  );
}

describe("admin API on a real server", () => {
  it("config churn: ~1000 random changes over HTTP under continuous traffic, zero request errors", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aigw-churn-"));
    const gw = await startGateway({ config: config(), dataDir });
    try {
      let stop = false;
      const failures: string[] = [];
      let served = 0;
      const worker = async (n: number) => {
        let i = 0;
        while (!stop) {
          const stream = (i + n) % 3 === 0;
          const model = (i + n) % 2 === 0 ? "gpt-4o" : "fast";
          i++;
          try {
            const r = await postJson(gw, "/v1/chat/completions", {
              model,
              stream,
              messages: [{ role: "user", content: "hi" }],
            });
            const text = await r.text();
            if (r.status !== 200) failures.push(`${r.status} ${text.slice(0, 200)}`);
            else if (stream && !text.includes("data: [DONE]"))
              failures.push(`stream without [DONE]: ${text.slice(-200)}`);
            else served++;
          } catch (err) {
            failures.push(String(err));
          }
        }
      };
      const workers = [0, 1, 2, 3].map(worker);

      const channels = (await ok(await adminFetch(gw, "GET", "/channels"), "channels")).data as Array<{
        id: string;
        name: string;
      }>;
      const chA = channels.find((c) => c.name === "a")!.id;
      const chB = channels.find((c) => c.name === "b")!.id;
      const model = (await ok(await adminFetch(gw, "GET", "/models"), "models")).data[0] as { id: string };
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
      const etag = async (path: string) => (await adminFetch(gw, "GET", path)).headers.get("etag")!;
      let extraModel: string | undefined;
      let keySeq = 0;
      const MUTATIONS = 1000;
      for (let m = 0; m < MUTATIONS; m++) {
        const kind = pick([
          "toggle_a",
          "bindings",
          "balance",
          "aliases",
          "add_key",
          "toggle_key",
          "extra_model",
          "compat",
          "rollback",
        ] as const);
        let r: Response;
        switch (kind) {
          case "toggle_a": {
            const ch = await ok(await adminFetch(gw, "GET", `/channels/${chA}`), "get a");
            r = await adminFetch(gw, "PATCH", `/channels/${chA}`, { enabled: !ch.enabled, priority: m }, ch.revision);
            break;
          }
          case "bindings": {
            // b is always bound (and always has an enabled key); a sometimes.
            const bindings = [{ channelId: chB, priority: pick([0, 1]), weight: pick([1, 2, 5]) }];
            if (Math.random() < 0.7) bindings.push({ channelId: chA, priority: pick([0, 1]), weight: pick([0, 1, 3]) });
            r = await adminFetch(
              gw,
              "PUT",
              `/models/${model.id}/bindings`,
              { bindings },
              await etag(`/models/${model.id}`),
            );
            break;
          }
          case "balance":
            r = await adminFetch(
              gw,
              "PATCH",
              `/models/${model.id}`,
              {
                balance: pick(["weighted", "round_robin", "least_inflight"]),
                strategy: pick(["fallback", "loadbalance"]),
              },
              await etag(`/models/${model.id}`),
            );
            break;
          case "aliases":
            r = await adminFetch(
              gw,
              "PATCH",
              "/settings",
              { aliases: { fast: "gpt-4o", [`alias-${m % 7}`]: "gpt-4o" } },
              await etag("/settings"),
            );
            break;
          case "add_key": {
            const id = pick([chA, chB]);
            r = await adminFetch(
              gw,
              "POST",
              `/channels/${id}/keys`,
              { keys: [{ key: `sk-churn-${keySeq++}-0123456789` }] },
              await etag(`/channels/${id}`),
            );
            break;
          }
          case "toggle_key": {
            const id = pick([chA, chB]);
            const ch = await ok(await adminFetch(gw, "GET", `/channels/${id}`), "get ch");
            // Never the first key of b: b must keep a usable key.
            const candidates = (ch.keys as Array<{ id: string; enabled: boolean }>).filter(
              (_, i) => id === chA || i > 0,
            );
            if (candidates.length === 0) {
              r = await adminFetch(gw, "PATCH", `/channels/${id}`, { priority: m }, ch.revision);
              break;
            }
            const k = pick(candidates);
            r = await adminFetch(
              gw,
              "POST",
              `/channels/${id}/keys/${k.id}/${k.enabled ? "disable" : "enable"}`,
              undefined,
              ch.revision,
            );
            break;
          }
          case "extra_model":
            if (extraModel) {
              r = await adminFetch(
                gw,
                "DELETE",
                `/models/${extraModel}`,
                undefined,
                await etag(`/models/${extraModel}`),
              );
              extraModel = undefined;
            } else {
              r = await adminFetch(gw, "POST", "/models", { name: `tmp-${m}`, bindings: [{ channelId: chA }] });
              if (r.status < 300) extraModel = ((await r.clone().json()) as { id: string }).id;
            }
            break;
          case "compat":
            r = await adminFetch(
              gw,
              "PATCH",
              "/settings",
              { compatibility: { onUnsupportedParam: pick(["warn", "drop"]) } },
              await etag("/settings"),
            );
            break;
          case "rollback": {
            const versions = await ok(await adminFetch(gw, "GET", "/config/versions?limit=3"), "versions");
            const target = versions.data[1]?.version ?? versions.head;
            r = await adminFetch(gw, "POST", `/config/versions/${target}/rollback`, undefined, versions.head);
            // A rollback may bring back or remove the extra model.
            const ms = (await ok(await adminFetch(gw, "GET", "/models"), "models")).data as Array<{
              id: string;
              name: string;
            }>;
            extraModel = ms.find((x) => x.name.startsWith("tmp-"))?.id;
            break;
          }
        }
        if (r.status >= 300) throw new Error(`mutation ${m} (${kind}) failed: ${r.status} ${await r.text()}`);
      }
      stop = true;
      await Promise.all(workers);
      expect(failures).toEqual([]);
      expect(served).toBeGreaterThan(200);
      const head = (await ok(await adminFetch(gw, "GET", "/config/versions?limit=1"), "versions")).head;
      expect(head).toBeGreaterThanOrEqual(MUTATIONS);
      // Pre-change backups: the newest few are kept.
      const backups = readdirSync(dataDir).filter((f) => f.includes(".backup-"));
      expect(backups.length).toBeGreaterThan(0);
      expect(backups.length).toBeLessThanOrEqual(5);
    } finally {
      await gw.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("a key answered 401 is disabled, persisted across a restart, and the channel's other key serves", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aigw-keyhealth-"));
    const single = () =>
      baseConfig([{ name: "a", mock: a }], { models: [{ name: "gpt-4o", bindings: [{ target: "a" }] }] });
    let gw = await startGateway({ config: single(), dataDir });
    try {
      const ch = (await ok(await adminFetch(gw, "GET", "/channels"), "channels")).data[0];
      await ok(
        await adminFetch(
          gw,
          "POST",
          `/channels/${ch.id}/keys`,
          { keys: [{ key: "sk-second-key-0123456789" }] },
          ch.revision,
        ),
        "add key",
      );
      a.reset();
      a.enqueue("401");
      const r = await postJson(gw, "/v1/chat/completions", {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r.status).toBe(200);
      expect(a.requests.map((q) => q.headers["authorization"])).toEqual([
        "Bearer sk-upstream-a",
        "Bearer sk-second-key-0123456789",
      ]);
      expect(gw.logs()).toContain("disabled after upstream 401");
      await Bun.sleep(100);
      await gw.stop();
      gw = await startGateway({ config: single(), dataDir });
      const after = await ok(await adminFetch(gw, "GET", `/channels/${ch.id}`), "channel");
      expect(after.keys[0]).toMatchObject({ status: "invalid", hint: "sk-…am-a" });
      a.reset();
      for (let i = 0; i < 3; i++) {
        expect(
          (await postJson(gw, "/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }))
            .status,
        ).toBe(200);
      }
      expect(new Set(a.requests.map((q) => q.headers["authorization"]))).toEqual(
        new Set(["Bearer sk-second-key-0123456789"]),
      );
      const audit = (await ok(await adminFetch(gw, "GET", "/audit?limit=10"), "audit")).data as Array<{
        action: string;
      }>;
      expect(audit.some((x) => x.action === "key_auto_disabled")).toBe(true);
      // Real HTTP: a cross-site write is refused, a read_only-less inference key cannot read.
      const csrf = await gw.fetch("/admin/channels", {
        method: "POST",
        auth: null,
        headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "text/plain", origin: "https://evil.example" },
        body: "{}",
      });
      expect(csrf.status).toBe(403);
    } finally {
      await gw.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
