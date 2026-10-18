# Known-open bug repros

Imported from the round-3 bug hunt (core / stream / sec). Every repro of a bug
that is still open is marked `it.failing(...)`: bun reports it as passing while
the bug reproduces, and **fails the run once the bug is fixed**. The fix PR
must flip the case to `it(...)` (it then becomes a regression test).
Repros of bugs already fixed were not imported; they have their own regression
tests under `tests/unit/`. A few plain `it(...)` cases are sanity guards that
pass today and must keep passing (including core/baseurl-envref-rejected, C3-10,
fixed by 1.4 while this suite was being written).

| File | Bug | Plan PR |
|---|---|---|
| sec/s3-5-config-scrub-gaps | S3-5 (remaining scrub gaps) — fixed, now a regression test | 3.3 |
| sec/s3-6-passthrough-method-fallthrough | S3-6 | 2.8 |
| core/limiter-queue-timeout-opens-breaker | C3-3 | 2.2 |
| core/budget-race | C3-5 | 3.6 |
| core/breaker-stale-outcome, core/breaker-fuzz (I3/I4) | C3-6 | 2.2 |
| core/prev-scopes-and-logstore | round-2: initRequestLogger never called | 2.3 |
| core/prev/mcp-loop | round-2: MCP depth error 500 (M2), MCP usage undercount (M3) | 2.7 |
| stream/stream-lifecycle | T3-3, T3-4, T3-5 | 2.5 |
| stream/sse-parser-fuzz | T3-10 | 2.5 |
| stream/adapters | T3-9 (fields), T3-11 (T3-8 and the T3-9 header case fixed in 1.4, T3-12 fixed in 2.1; kept as plain it) | 2.6 |
| stream/completions | T3-7 | 2.6 |

B3-7 (error shape / target leak) and the round-2 "upstream 429/500 -> 500"
item were fixed in 2.1; their e2e cases in `tests/e2e/errors.e2e.ts` are plain
`it` now.

Black-box findings (B3-*) are covered by the e2e contract suite in `tests/e2e/`
(`bun run test:e2e`), also with `it.failing` for the open ones.
