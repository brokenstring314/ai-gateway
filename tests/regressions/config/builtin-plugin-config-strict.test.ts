// Backlog #4: built-in plugin configs other than pii-secret-guard were not
// validated, so typos (word-filter `caseSensitive`, max-token `maxMessages`,
// cache `ttl`) were silently ignored. Every built-in now has a strict schema.
import { describe, expect, it } from "bun:test";
import { buildPluginsFromConfig } from "@/plugins/builtins/from-config";
import { base, errors, ok } from "./_h";

const plugin = (name: string, config: Record<string, unknown> | undefined) =>
  base({ plugins: [{ name, stage: "before_request", ...(config === undefined ? {} : { config }) }] });

describe("strict built-in plugin config (backlog #4)", () => {
  const typos: [string, Record<string, unknown>, RegExp][] = [
    ["word-filter", { blockedWords: ["x"], caseSensitive: true }, /unknown key "caseSensitive"/],
    ["max-token", { maxTokens: 10, maxMessages: 5 }, /unknown key "maxMessages"/],
    ["cache", { ttlSecond: 60 }, /unknown key "ttlSecond" \(did you mean "ttlSeconds"\?\)/],
    ["rate-limit", { maxRequestsPerMinute: 5, maxRequestPerDay: 9 }, /did you mean "maxRequestsPerDay"/],
    ["budget", { dailyBudget: 1, costPer1kInput: 0.1, dailybudget: 2 }, /unknown key "dailybudget"/],
  ];
  for (const [name, config, expected] of typos) {
    it(`${name}: unknown key is a validation error`, () => {
      const msg = errors(plugin(name, config));
      expect(msg).toMatch(new RegExp(`^plugins\\.0\\.config: ${name}: `, "m"));
      expect(msg).toMatch(expected);
    });
  }

  it("wrong types and values are errors", () => {
    expect(errors(plugin("word-filter", { blockedWords: ["x"], mode: "block" }))).toMatch(/mode/);
    expect(errors(plugin("max-token", { maxTokens: "4096" }))).toMatch(/maxTokens/);
    expect(errors(plugin("rate-limit", {}))).toMatch(/maxRequestsPerMinute/);
    expect(errors(plugin("cache", { maxAge: -1 }))).toMatch(/maxAge/);
    expect(errors(plugin("rate-limit", { rpm: 5, keyRpm: 6 }))).toMatch(/only one of/);
  });

  it("documented keys and aliases still validate", () => {
    ok(plugin("rate-limit", { maxRequestsPerMinute: 60, maxRequestsPerDay: 5000, key: "shared" }));
    ok(plugin("rate_limit", { rpm: 60, rpd: 100 }));
    ok(plugin("cache", { maxAge: 300, maxEntries: 1000 }));
    ok(plugin("cache", undefined));
    ok(plugin("word-filter", { blocklist: ["x"], mode: "redact" }));
    ok(plugin("max-token", { maxTokens: 4096 }));
    ok(plugin("budget", { dailyBudget: 100, costPer1kInput: 0.01, costPer1kOutput: 0.03, reserveOutputTokens: 512 }));
  });

  it("a disabled entry is not validated", () => {
    ok(base({ plugins: [{ name: "word-filter", stage: "before_request", enabled: false, config: { nope: 1 } }] }));
  });

  it("the embedded path (no schema) fails on the same typo", () => {
    expect(() =>
      buildPluginsFromConfig([
        { name: "max-token", stage: "before_request", config: { maxTokens: 10, maxMessages: 5 } } as never,
      ]),
    ).toThrow(/maxMessages/);
  });
});
