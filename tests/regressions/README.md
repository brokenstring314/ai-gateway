# Bug-hunt repros (now regression tests)

Imported from the round-3 bug hunt (core / stream / sec). **Every bug below is
fixed and no `it.failing(...)` case is left** in `tests/regressions/` or
`tests/e2e/`. The convention for new repros stays: a repro of a bug that is
still open is marked `it.failing(...)` (bun reports it as passing while the
bug reproduces and **fails the run once the bug is fixed**); the fix PR flips
it to `it(...)`, which makes it a regression test.
Repros of bugs already fixed were not imported; they have their own regression
tests under `tests/unit/`. A few plain `it(...)` cases are sanity guards that
pass today and must keep passing (including core/baseurl-envref-rejected, C3-10,
fixed by 1.4 while this suite was being written).

| File | Bug | Plan PR |
|---|---|---|
| sec/s3-5-config-scrub-gaps | S3-5 (remaining scrub gaps) — fixed, now a regression test | 3.3 |
| sec/s3-6-passthrough-method-fallthrough | S3-6 — fixed (route allow-list, 405 on gateway routes, max-token on proxied bodies), now a regression test | 2.8 |
| core/limiter-queue-timeout-opens-breaker | C3-3 — fixed (abortable limiter wait), now a regression test | 2.2 |
| core/budget-race | C3-5 — fixed (reserve in before, settle after; budget without rates is a config error), now regression tests | 3.6 |
| core/breaker-stale-outcome, core/breaker-fuzz (I3/I4) | C3-6 — fixed (permit-based settlement), now regression tests | 2.2 |
| core/prev-scopes-and-logstore | round-2: initRequestLogger never called — fixed (finalize → log store sink), now a regression test | 2.3 |
| core/prev/mcp-loop | round-2: MCP depth error 500 (M2), MCP usage undercount (M3) — fixed (core/mcp-loop.ts), now regression tests | 2.7 |
| stream/stream-lifecycle | T3-3, T3-4, T3-5 — fixed (parser ends on [DONE], truncation = error, empty / non-SSE 200 = failed attempt), now regression tests | 2.5 |
| stream/sse-parser-fuzz | T3-10 — fixed (CR / CRLF line ends, incremental O(n) scan, 4 MiB line/event cap, bad JSON and `event: error` = error, choices[null] guarded), now regression tests; the 8 MiB case now asserts the cap | 2.5 |
| stream/adapters | T3-9 (fields), T3-11 — fixed in 2.6 (allow-listed pass-through, max-token injection); T3-8 and the T3-9 header case fixed in 1.4, T3-12 in 2.1; all plain `it` now | 2.6 |
| stream/completions | T3-7 — fixed (text_completion wire format), now a regression test | 2.6 |
| config/request-timeout-duration | PLAN backlog: `requestTimeout: 500ms` read as 500 minutes — fixed (shared duration parser) | post-0.2.0 |
| config/tracing-grpc-rejected | PLAN backlog: `otlpProtocol: grpc` accepted but ignored — fixed (validation error) | post-0.2.0 |
| config/target-priority-budget-rejected | PLAN backlog: `targets[].priority` / `budget` never read — fixed (validation error + hint) | post-0.2.0 |
| config/builtin-plugin-config-strict | PLAN backlog: built-in plugin config typos silently ignored — fixed (strict schemas) | post-0.2.0 |
| config/mcp-max-call-depth | PLAN backlog: MCP `maxCallDepth` from the first server only — fixed (smallest across servers) | post-0.2.0 |
| qa/sigterm-drain-streams | QA round (load test): SIGTERM reset every in-flight stream (drain counted the SSE handler as done) — fixed | post-0.2.0 |
| qa/request-log-db | QA round (load test): request-log SQLite in rollback/FULL mode capped throughput, "database is locked" lost rows; upstream errors logged as provider `unknown` — fixed | post-0.2.0 |
| qa/stream-provider-header | QA round (real DeepSeek): streaming `X-Gateway-Provider` = upstream model, metrics `provider` label from it; completions had none — fixed | post-0.2.0 |
| qa/stream-usage-estimate-reasoning | QA round: estimated stream usage (no usage chunk) ignored reasoning_content — fixed | post-0.2.0 |
| qa/null-optional-params | QA round (real DeepSeek + body fuzz): explicit `null` optional params → 400 — fixed | post-0.2.0 |
| config/dashboard-dead-assets | PLAN backlog: unserved `dashboard.js` / `style.css` — deleted | post-0.2.0 |

B3-6 (/metrics series) and the round-2 "/admin/logs empty" item were fixed in
2.3; their e2e cases in `tests/e2e/ops.e2e.ts` are plain `it` now.
B3-7 (error shape / target leak) and the round-2 "upstream 429/500 -> 500"
item were fixed in 2.1; their e2e cases in `tests/e2e/errors.e2e.ts` are plain
`it` now. T3-3 / T3-4 / T3-5 in `tests/e2e/stream-lifecycle.e2e.ts` are plain
`it` since 2.5. T3-7 (`tests/e2e/completions.e2e.ts`) and T3-11
(`tests/e2e/chat.e2e.ts`) were fixed in 2.6 and are plain `it` too.

Black-box findings (B3-*) are covered by the e2e contract suite in `tests/e2e/`
(`bun run test:e2e`); all of its cases are plain `it` as well.
