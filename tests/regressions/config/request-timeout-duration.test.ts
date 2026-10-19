// Backlog #1: `requestTimeout: "500ms"` passed validation but the timeout
// middleware had no `ms` unit and read it as 500 minutes; `1m30s` was parsed
// by the middleware but rejected by the schema. One parser now serves both.
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requestTimeoutMiddleware } from "@/middleware/request-timeout";
import { base, errors, ok } from "./_h";

async function abortedWithin(timeout: string, budgetMs: number): Promise<number | null> {
  const app = new Hono<{ Variables: { abortController: AbortController } }>();
  app.use("*", requestTimeoutMiddleware(timeout));
  app.get("/", async (c) => {
    const signal = c.get("abortController").signal;
    const started = performance.now();
    const aborted = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), budgetMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    return c.json({ elapsed: aborted ? performance.now() - started : null });
  });
  const res = await app.request("/");
  return ((await res.json()) as { elapsed: number | null }).elapsed;
}

describe('requestTimeout "500ms" (backlog #1)', () => {
  it("aborts after ~500 ms, not 500 minutes", async () => {
    const elapsed = await abortedWithin("500ms", 2_000);
    expect(elapsed).not.toBeNull();
    expect(elapsed!).toBeGreaterThanOrEqual(400);
    expect(elapsed!).toBeLessThan(1_500);
  });

  it("validation accepts what the middleware parses (ms, s, m, h and compounds like 1m30s)", () => {
    for (const d of ["500ms", "30s", "5m", "1h", "1m30s", "1h30m", "2s500ms"]) ok(base({ requestTimeout: d }));
  });

  it("validation rejects garbage, missing units, zero and unknown units", () => {
    for (const d of ["abc", "30", "0s", "5x", "1.5s", "-5s", "30 s", "", "ms", "30s "]) {
      expect(errors(base({ requestTimeout: d }))).toMatch(/requestTimeout/);
    }
  });

  it("tracing.shutdownGrace uses the same rules", () => {
    ok(base({ observability: { tracing: { shutdownGrace: "1m30s" } } }));
    expect(errors(base({ observability: { tracing: { shutdownGrace: "10" } } }))).toMatch(/shutdownGrace/);
  });

  it("an invalid duration that skipped validation fails loudly instead of being misread", () => {
    expect(() => requestTimeoutMiddleware("500x")).toThrow(/requestTimeout/);
  });
});
