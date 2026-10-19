// Backlog #3: `targets[].priority` and `targets[].budget` were accepted but
// never read by any strategy or plugin. Strict validation now rejects them
// with a migration hint (like the keys removed in 0.2.0).
import { describe, expect, it } from "bun:test";
import { base, errors, target } from "./_h";

describe("targets[].priority / targets[].budget (backlog #3)", () => {
  it("priority is rejected with a hint pointing at fallback ordering", () => {
    const msg = errors(base({ targets: [target("a", { priority: 1 })] }));
    expect(msg).toMatch(/^targets\.0: targets\[\]\.priority .*strategy\.targets/m);
    expect(msg).not.toMatch(/valid keys/);
  });

  it("budget is rejected with a hint pointing at the budget plugin", () => {
    const msg = errors(base({ targets: [target("a", { budget: 50 })] }));
    expect(msg).toMatch(/^targets\.0: targets\[\]\.budget .*budget plugin/m);
  });
});
