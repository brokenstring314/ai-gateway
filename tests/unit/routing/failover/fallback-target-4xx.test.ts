// R3-H4 (C3-2 / B3-3): fallback must fail over on target-caused 4xx (401/403
// credential or permission, 404 model/route missing at that target), count
// 401/403 as breaker failures, and keep caller-caused 4xx (400/413/422) fatal
// without touching the breaker.
import { describe, it, expect } from "bun:test";
import { mk, req, tgt, code } from "./_h";

const cb = { failureThreshold: 1, timeoutMs: 60_000 };
const fallbackCfg = () => ({
  strategy: { mode: "fallback", targets: ["primary", "backup"] },
  targets: [tgt("primary", { circuitBreaker: cb }), tgt("backup")],
});

describe("fallback vs target-caused upstream 4xx", () => {
  it("primary key revoked (401) -> backup serves every request and the breaker opens", async () => {
    const { g, calls } = mk(fallbackCfg(), ["primary", "backup"], { primary: "401", backup: "ok" });
    const r: string[] = [];
    for (let i = 0; i < 10; i++) r.push(await code(g.route({} as any, req)));
    expect(r.filter((x) => x === "ok:backup").length).toBe(10);
    expect(g.getCircuitBreakerRegistry().get("primary")!.getState()).toBe("OPEN");
    expect(calls["primary"]).toBe(1); // later requests skip the open breaker
  });

  it("403 fails over and counts toward the breaker", async () => {
    const { g } = mk(fallbackCfg(), ["primary", "backup"], { primary: "403", backup: "ok" });
    expect(await code(g.route({} as any, req))).toBe("ok:backup");
    expect(g.getCircuitBreakerRegistry().get("primary")!.getState()).toBe("OPEN");
  });

  it("404 fails over but does not open the breaker", async () => {
    const { g } = mk(fallbackCfg(), ["primary", "backup"], { primary: "404", backup: "ok" });
    for (let i = 0; i < 3; i++) expect(await code(g.route({} as any, req))).toBe("ok:backup");
    expect(g.getCircuitBreakerRegistry().get("primary")!.getState()).toBe("CLOSED");
  });

  for (const s of ["400", "413", "422"] as const) {
    it(`caller-caused ${s} is surfaced without failover or breaker count`, async () => {
      const { g, calls } = mk(fallbackCfg(), ["primary", "backup"], { primary: s, backup: "ok" });
      expect(await code(g.route({} as any, req))).toBe(s);
      expect(calls["backup"]).toBe(0);
      expect(g.getCircuitBreakerRegistry().get("primary")!.getState()).toBe("CLOSED");
    });
  }
});
