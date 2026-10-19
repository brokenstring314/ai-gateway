// Backlog #6: src/dashboard/static/dashboard.js and style.css were leftovers of
// the old placeholder dashboard: not served, not imported, not built.
// Every file in src/dashboard/static must be an asset the console serves.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../../../src/dashboard/static");

describe("dashboard static assets (backlog #6)", () => {
  it("every file under src/dashboard/static is imported by src/dashboard/index.ts", () => {
    const index = readFileSync(join(dir, "../index.ts"), "utf8");
    const unreferenced = readdirSync(dir).filter((f) => !index.includes(`./static/${f}`));
    expect(unreferenced).toEqual([]);
  });
});
