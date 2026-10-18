// 3.8 (B3-11): strict config keys + cross-reference checks, shared by
// `validate`, bootstrap() and the embedded Gateway constructor.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateCommand } from "@/cli/index";
import { ConfigValidationError, loadConfigFromObject, loadConfigFromPath } from "@/config/loader";
import { safeParseConfig } from "@/config/schema";
import type { GatewayConfig } from "@/config/types";
import { Gateway } from "@/gateway";

const target = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  provider: "openai",
  apiKey: "sk-x",
  ...extra,
});

function errors(input: unknown): string {
  const r = safeParseConfig(input);
  expect(r.success).toBe(false);
  return (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
}

describe("unknown and misspelt keys are errors (B3-11 c)", () => {
  const typos: [string, Record<string, unknown>, RegExp][] = [
    [
      "top-level requestTimout",
      { requestTimout: "5s" },
      /unknown key "requestTimout" \(did you mean "requestTimeout"\?\)/,
    ],
    ["top-level maxRequestByte", { maxRequestByte: 10 }, /did you mean "maxRequestBytes"/],
    ["top-level adminsecret", { adminsecret: "long-enough-secret" }, /did you mean "adminSecret"/],
    ["auth.key", { auth: { key: ["k"] } }, /^auth: unknown key "key" \(did you mean "keys"\?\)/m],
    [
      "target circuitbreaker",
      { targets: [target("a", { circuitbreaker: {} })] },
      /^targets\.0: .*did you mean "circuitBreaker"/m,
    ],
    [
      "target retries",
      { targets: [target("a", { retries: {} })] },
      /^targets\.0: unknown key "retries" \(did you mean "retry"\?\)/m,
    ],
    [
      "nested retry key",
      { targets: [target("a", { retry: { attempt: 2 } })] },
      /^targets\.0\.retry: .*did you mean "attempts"/m,
    ],
    ["server key", { server: { prot: 1 } }, /^server: unknown key "prot" \(did you mean "port"\?\)/m],
  ];
  for (const [label, override, expected] of typos) {
    it(label, () => {
      expect(errors({ strategy: { mode: "single" }, targets: [target("a")], ...override })).toMatch(expected);
    });
  }

  it("a key with no close match lists the valid keys", () => {
    expect(errors({ strategy: { mode: "single" }, targets: [target("a")], cors: { zzzzzz: 1 } })).toMatch(
      /unknown key "zzzzzz"; valid keys: enabled, origins, allowHeaders/,
    );
  });

  it("removed strategy keys keep their migration hint", () => {
    expect(errors({ strategy: { mode: "single", keywords: { a: "b" } }, targets: [target("a")] })).toMatch(
      /strategy\.keywords was removed in 0\.2\.0/,
    );
  });
});

describe("cross-references (B3-11 a, b, d)", () => {
  it("fallback target that does not exist", () => {
    expect(
      errors({ strategy: { mode: "fallback", targets: ["primary", "typo-backup"] }, targets: [target("primary")] }),
    ).toMatch(/^strategy\.targets\.1: strategy\.targets references unknown target "typo-backup"/m);
  });

  it("weights and rules must name existing targets", () => {
    const e = errors({
      strategy: {
        mode: "conditional",
        weights: { ghost: 1 },
        rules: [{ field: "model", contains: "x", target: "nope" }],
      },
      targets: [target("a")],
    });
    expect(e).toMatch(/^strategy\.weights\.ghost: .*unknown target "ghost"/m);
    expect(e).toMatch(/^strategy\.rules\.0\.target: .*unknown target "nope"/m);
  });

  it("target names are unique", () => {
    expect(errors({ strategy: { mode: "single" }, targets: [target("a"), target("a")] })).toMatch(
      /^targets\.1\.name: duplicate target name "a"/m,
    );
  });

  it("unknown provider without baseURL fails validation (not just startup)", () => {
    expect(errors({ strategy: { mode: "single" }, targets: [{ name: "x", provider: "acme", apiKey: "k" }] })).toMatch(
      /^targets\.0\.baseURL: target "x": unknown provider "acme" needs a baseURL/m,
    );
    expect(
      errors({ strategy: { mode: "single" }, targets: [{ name: "c", provider: "cloudflare", apiKey: "k" }] }),
    ).toMatch(/provider "cloudflare" needs an explicit baseURL/);
    expect(
      safeParseConfig({
        strategy: { mode: "single" },
        targets: [{ name: "x", provider: "acme", apiKey: "k", baseURL: "${ACME_URL}" }],
      }).success,
    ).toBe(true);
  });
});

describe("one validator for validate, bootstrap and embedded Gateway", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("validate CLI reports every problem with its path and exits 1", () => {
    dir = mkdtempSync(join(tmpdir(), "agw-strict-"));
    const path = join(dir, "c.yaml");
    writeFileSync(
      path,
      "strategy: { mode: fallback, targets: [a, b] }\ntargets: [{ name: a, provider: openai, apiKey: k }]\nretries: 3\n",
    );
    const out: string[] = [];
    const sink = { log: (m: string) => out.push(m), error: (m: string) => out.push(m) };
    expect(validateCommand(path, sink)).toBe(1);
    expect(out.join("\n")).toContain('unknown key "retries"');
    writeFileSync(
      path,
      "strategy: { mode: fallback, targets: [a, b] }\ntargets: [{ name: a, provider: openai, apiKey: k }]\n",
    );
    out.length = 0;
    expect(validateCommand(path, sink)).toBe(1);
    expect(out.join("\n")).toMatch(/unknown target "b"[\s\S]*strategy\.targets\[1\]/);
    expect(() => loadConfigFromPath(path)).toThrow(ConfigValidationError);
  });

  it("embedded new Gateway(config) runs the same cross-reference checks", () => {
    const cfg = { strategy: { mode: "fallback", targets: ["a", "ghost"] }, targets: [target("a")] } as GatewayConfig;
    expect(() => new Gateway(cfg)).toThrow(/unknown target "ghost"/);
    const dup = { strategy: { mode: "single" }, targets: [target("a"), target("a")] } as GatewayConfig;
    expect(() => new Gateway(dup)).toThrow(/duplicate target name "a"/);
  });
});

describe("AI_GATEWAY_* overrides resolve against the schema", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("AI_GATEWAY_") && !(k in saved)) delete process.env[k];
  });

  it("camelCase keys, arrays and unknown variables", () => {
    process.env["AI_GATEWAY_MAX_REQUEST_BYTES"] = "2048";
    process.env["AI_GATEWAY_SERVER_PORT"] = "8081";
    process.env["AI_GATEWAY_CORS_ORIGINS"] = "https://a.example, https://b.example";
    process.env["AI_GATEWAY_ADMIN_SECRET"] = "123456789"; // string field: not turned into a number
    process.env["AI_GATEWAY_NOT_A_KEY"] = "1"; // ignored with a warning, not a strict-schema error
    const cfg = loadConfigFromObject({ strategy: { mode: "single" }, targets: [target("a")] });
    expect(cfg.maxRequestBytes).toBe(2048);
    expect(cfg.server?.port).toBe(8081);
    expect(cfg.cors?.origins).toEqual(["https://a.example", "https://b.example"]);
    expect(cfg.adminSecret).toBe("123456789");
  });
});

describe("shipped example configs still validate", () => {
  it("config.example.yaml / config.example.json", () => {
    for (const f of ["config.example.yaml", "config.example.json"]) {
      expect(() => loadConfigFromPath(join(import.meta.dir, "../../..", f))).not.toThrow();
    }
  });

  it("README / README_CN yaml blocks (snippets get the targets they reference)", () => {
    for (const f of ["README.md", "README_CN.md"]) {
      const md = readFileSync(join(import.meta.dir, "../../..", f), "utf-8");
      for (const [, block] of md.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
        const snippet = parseYaml(block!) as Record<string, unknown> | null;
        if (snippet === null || typeof snippet !== "object" || Array.isArray(snippet)) continue;
        const s = (snippet["strategy"] ?? {}) as {
          targets?: string[];
          weights?: Record<string, number>;
          rules?: { target: string }[];
        };
        const referenced = new Set([
          ...(s.targets ?? []),
          ...Object.keys(s.weights ?? {}),
          ...(s.rules ?? []).map((r) => r.target),
        ]);
        const full = {
          strategy: { mode: "single" },
          targets: referenced.size > 0 ? [...referenced].map((n) => target(n)) : [target("t")],
          ...snippet,
        };
        const r = safeParseConfig(full);
        if (!r.success) throw new Error(`${f} example failed:\n${block}\n${r.error.message}`);
      }
    }
  });
});
