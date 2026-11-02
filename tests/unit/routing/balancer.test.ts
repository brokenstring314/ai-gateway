/** Channel-level balancing (0.3.0 P4): priority groups and in-group modes. */
import { describe, expect, it } from "bun:test";
import { PriorityGroupStrategy, priorityGroups, TargetLoad } from "../../../src/routing/balancer.js";

const req = { model: "m", messages: [] };
const g = (...names: Array<[string, number?]>) => names.map(([name, weight]) => ({ name, weight: weight ?? 1 }));

describe("priorityGroups", () => {
  it("groups by ascending priority, stable within a group", () => {
    const groups = priorityGroups([
      { n: "c", priority: 1 },
      { n: "a", priority: 0 },
      { n: "d", priority: 1 },
      { n: "b", priority: 0 },
      { n: "e", priority: 5 },
    ]);
    expect(groups.map((x) => x.map((y) => y.n))).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
});

describe("PriorityGroupStrategy", () => {
  it("lists the whole first group before the next (failover order)", () => {
    const s = new PriorityGroupStrategy([g(["a"], ["b"]), g(["c"])], "round_robin", new TargetLoad());
    for (let i = 0; i < 5; i++) {
      const order = s.selectTargets(req);
      expect(new Set(order.slice(0, 2))).toEqual(new Set(["a", "b"]));
      expect(order[2]).toBe("c");
    }
  });

  it("round_robin rotates within the group", () => {
    const s = new PriorityGroupStrategy([g(["a"], ["b"], ["c"])], "round_robin", new TargetLoad());
    expect([1, 2, 3, 4].map(() => s.selectTargets(req)[0])).toEqual(["a", "b", "c", "a"]);
    expect(s.selectTargets(req)).toEqual(["b", "c", "a"]);
  });

  it("weighted follows the weights", () => {
    const s = new PriorityGroupStrategy([g(["a", 4], ["b", 1])], "weighted", new TargetLoad());
    let a = 0;
    for (let i = 0; i < 5000; i++) if (s.selectTargets(req)[0] === "a") a++;
    expect(a / 5000).toBeGreaterThan(0.75);
    expect(a / 5000).toBeLessThan(0.85);
  });

  it("least_inflight prefers the channel with fewer requests in flight (per weight)", () => {
    const load = new TargetLoad();
    const s = new PriorityGroupStrategy([g(["a"], ["b"], ["c", 2])], "least_inflight", load);
    load.inc("a");
    load.inc("a");
    load.inc("b");
    load.inc("c");
    load.inc("c");
    // a: 2/1, b: 1/1, c: 2/2 → b or c (tie) first, a last.
    const order = s.selectTargets(req);
    expect(order.at(-1)).toBe("a");
    load.dec("b");
    expect(s.selectTargets(req)[0]).toBe("b");
    expect(load.get("b")).toBe(0);
  });

  it("weight 0 drains a binding; empty groups disappear", () => {
    const s = new PriorityGroupStrategy([g(["a", 0]), g(["b"], ["c", 0])], "weighted", new TargetLoad());
    expect(s.selectTargets(req)).toEqual(["b"]);
    expect(s.members().length).toBe(1);
  });
});
