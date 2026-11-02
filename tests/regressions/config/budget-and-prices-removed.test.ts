// 0.3.0 P5 (user decision 2026-11-02): the gateway is not a paid API service.
// The budget plugin, target prices (costPer1k*Tokens), the cost metric and
// upstream `cost` passthrough are gone. Configs that still use them fail
// validation with a "removed in 0.3.0" hint; stored runtime config is
// migrated (prices dropped) so an existing database keeps starting.
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { assertConfigReferences } from "@/config/validate";
import { Gateway } from "@/gateway";
import { getMetrics } from "@/metrics/metrics";
import { ConfigStore } from "@/persistence/config-store";
import { SecretBox } from "@/secrets/secret-box";
import { loadConfigFromObject } from "@/config/loader";
import { base, errors, target } from "./_h";

const budget = (extra: Record<string, unknown> = {}) => ({
  name: "budget",
  stage: "before_request",
  config: { dailyBudget: 10 },
  ...extra,
});

describe("budget plugin removed in 0.3.0", () => {
  for (const [label, entry] of [
    ["enabled", budget()],
    ["snake/upper-case name", budget({ name: " Budget " })],
    ["disabled entry", budget({ enabled: false })],
    ["without config", { name: "budget", stage: "after_request" }],
  ] as const) {
    it(`${label}: validation error with the migration hint`, () => {
      const msg = errors(base({ plugins: [entry] }));
      expect(msg).toMatch(/^plugins\.0\.name: the budget plugin was removed in 0\.3\.0/m);
      expect(msg).toContain("quotaTokens");
    });
  }

  it("embedded configs (no schema) are refused the same way", () => {
    const cfg = { strategy: { mode: "single" }, targets: [target("a")], plugins: [budget()] } as never;
    expect(() => assertConfigReferences(cfg)).toThrow(/budget plugin was removed in 0\.3\.0/);
    expect(() => new Gateway(cfg)).toThrow(/budget plugin was removed in 0\.3\.0/);
  });
});

describe("prices removed in 0.3.0", () => {
  it("targets[].costPer1kInputTokens / costPer1kOutputTokens are validation errors with a hint", () => {
    const msg = errors(base({ targets: [target("a", { costPer1kInputTokens: 0.1, costPer1kOutputTokens: 0.2 })] }));
    expect(msg).toMatch(/targets\[\]\.costPer1kInputTokens was removed in 0\.3\.0/);
    expect(msg).toMatch(/targets\[\]\.costPer1kOutputTokens was removed in 0\.3\.0/);
    expect(msg).not.toMatch(/valid keys/);
  });

  it("no cost metric is registered", async () => {
    expect(await getMetrics().format()).not.toMatch(/cost|usd/i);
  });

  it("an existing config store is migrated: model pricing column and channel prices dropped", async () => {
    const db = new Database(":memory:");
    const box = await SecretBox.create(new Uint8Array(32).fill(7));
    const cfg = loadConfigFromObject({ strategy: { mode: "single" }, targets: [target("a", { models: ["m"] })] });
    const store = await ConfigStore.create(db, box);
    await store.importFromConfig(cfg);
    // Put the database back into its pre-0.3.0-P5 shape.
    db.exec("ALTER TABLE models ADD COLUMN pricing_json TEXT NOT NULL DEFAULT '{}'");
    db.exec(
      `UPDATE channels SET settings_json = '{"weight":2,"costPer1kInputTokens":0.1,"costPer1kOutputTokens":0.2}'`,
    );
    db.exec("DELETE FROM config_schema_migrations WHERE version = 3");
    const reopened = await ConfigStore.create(db, box);
    const cols = (db.query("PRAGMA table_info(models)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("pricing_json");
    const settings = JSON.parse(
      (db.query("SELECT settings_json FROM channels").get() as { settings_json: string }).settings_json,
    );
    expect(settings).toEqual({ weight: 2 });
    // And the stored runtime config loads (strict validation passes).
    const loaded = await reopened.loadRuntimeSections();
    expect(loaded.targets?.[0]).not.toHaveProperty("costPer1kInputTokens");
  });
});
