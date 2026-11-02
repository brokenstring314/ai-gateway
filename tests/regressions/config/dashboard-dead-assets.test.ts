// Backlog #6: the console must not ship dead assets. Since 0.3.0 P6 the console is
// built by Vite and embedded (src/dashboard/assets.generated.ts); every embedded
// asset must be referenced by index.html, and the 0.2 static directory is gone.
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONSOLE_ASSETS, CONSOLE_INDEX_HTML } from "../../../src/dashboard/assets.generated";

describe("dashboard static assets (backlog #6)", () => {
  it("every embedded asset is referenced by index.html", () => {
    const unreferenced = Object.keys(CONSOLE_ASSETS).filter((f) => !CONSOLE_INDEX_HTML.includes(`/assets/${f}`));
    expect(unreferenced).toEqual([]);
  });

  it("the 0.2 vanilla console directory is removed", () => {
    expect(existsSync(join(import.meta.dir, "../../../src/dashboard/static"))).toBe(false);
  });
});
