# Changelog

## 0.2.0 (Unreleased)

### Breaking changes

- **Config is file-only; hot reload and the config write API are removed.**
  `PUT /admin/config`, `DELETE /admin/config`, `POST /admin/config/reload`,
  `GET /admin/config/history` and `POST /admin/config/rollback/:version` now
  answer `410 config_api_removed`. `GET /admin/config` (scrubbed) stays.
  `Gateway.reloadConfig()` is removed from the embedded API. A config saved
  through the old API (`.data/gateway-config.sqlite`) is no longer loaded at
  startup and no longer shadows the config file; the gateway logs a warning
  if the file still exists. `SIGHUP` is logged and ignored instead of killing
  the process. `/readyz` reports `stores` (key/log store health) instead of
  `configStore`.
  *Migration:* edit the config file and restart (rolling restart behind a
  load balancer). Delete `.data/gateway-config.sqlite`.
  (Closes B3-5, S3-4, the history part of S3-5, and the non-atomic reload
  issue from round 2.)
- **Routing strategies reduced to four: `single`, `fallback`, `loadbalance`,
  `conditional`.** Removed: `least_latency` (a dead target kept winning every
  pick), `cost_optimized` (the cheapest target being down failed 100% of
  requests), `content_based` (folded into `conditional`), and the Go config
  bridge (`strategy.conditions`, `contentConditions`/`content_conditions`,
  `keywords`, `abVariants`/`ab_variants`, `unpricedStrategy`/`unpriced_strategy`).
  Each removed mode or key fails `validate` and startup with a hint, e.g.
  `strategy mode least_latency was removed in 0.2.0; use fallback`.
  `abtest` (and `ab-test`) remain one release as a deprecated alias of
  `loadbalance`, with a startup warning.
  *Migration:* `least_latency` → `fallback`; `cost_optimized` → `fallback`
  ordered by price; `content_based` keywords → `conditional` rules
  `{ field: prompt, contains: <keyword>, target }` (or `pattern:` for a regex);
  `abtest` → `loadbalance` with `weights`; Go `conditions` →
  `rules: [{ field, pattern, target }]`.
- **Conditional rules**: new `field: prompt` (all user-message text) and
  `contains:` (case-insensitive substring) next to `pattern:`. A rule needs
  exactly one of the two; `field` must be `model`, `user`, `message` or
  `prompt`; regexes are validated at startup instead of failing per request.
- **Load balance weight 0 now drains a target** (it was treated as weight 1).
  A drained target gets no traffic, not even as a failover candidate; negative
  weights and an all-zero pool are rejected. (Closes C3-9.)
- **Dead code removed** (no behaviour existed behind it):
  - the `logger` plugin: a `logger` entry in `plugins` is ignored with one
    startup warning (the gateway already writes one request-log line per
    request);
  - MCP `type: http` / `url` / `headers`: never implemented (connect threw);
    now a validation error with a hint. stdio is the only transport;
  - `observability.exporters` and the exporter registry (no exporter ever
    existed); use `observability.tracing` (OTLP);
  - the built-in `Tracer` / OTLP-JSON exporter and `initTracing()` (spans
    already went through the OpenTelemetry bridge; `getTracer()` stays);
  - the second in-memory metrics registry (`observability/metrics.ts`, which
    `/metrics` never served and which stored every duration sample). Plugin
    rejections/short-circuits are now `ai_gateway_plugin_blocked_total`, and
    chat token usage is exported as `ai_gateway_tokens_{input,output}_total`;
  - `IDiscoveryProvider` (no implementation), and `scrubConfigJson` (only
    used by the removed config history).
- **Provider presets are one table** (`src/core/provider-presets.ts`). The 22
  `providers/definitions/*.ts` factories and their `createOpenAI()`,
  `createMistral()`, … exports are removed; embedders use
  `createProviderFromTarget(target, compatibility?)` or
  `createOpenAICompatProvider()`. `cloudflare` and `databricks` have no
  default `baseURL` any more (the old defaults were not usable URLs) and an
  unknown provider without `baseURL` fails at startup with a clear message.
  `openrouter` targets now send `HTTP-Referer`/`X-Title`; perplexity
  `citations`/`search_results` are kept in response metadata. The pass-through
  proxy now uses the preset base URL when a target has no `baseURL`.
- **`compatibility.onUnsupportedParam` now works.** Capability checks are keyed
  on `target.provider` instead of the target name (they never matched before),
  the configured mode is passed to every provider (it was always `warn`), and
  `drop` removes every unsupported field (snake/camel mismatch fixed). The
  `developer` role check now runs. With `reject`, unsupported parameters give a
  400 listing their wire names. (Closes T3-8, T3-9 header part.)
- **`${VAR}` in `targets[].baseURL` is accepted by the schema** and validated as
  an http(s) URL after expansion. (Closes C3-10.)
- **One CLI and one server bootstrap.** `src/index.ts` and `src/cli/index.ts`
  had separate argument parsers, help texts, versions (`1.0.0` vs `0.1.0`) and
  `validate` implementations; there is now one CLI (`src/cli/index.ts`) and
  one `bootstrap()` (`src/server/bootstrap.ts`) used by every server entry
  point. `-h` now means `--host` everywhere (help is `--help`); unknown options
  are an error. `serve()` remains exported as an alias of `bootstrap()`, which
  now returns a handle (`server`, `gateway`, `stop()`) and throws on a bad
  config instead of calling `process.exit`.

### Security

- **`ADMIN_BOOTSTRAP_KEY` / `ADMIN_BOOTSTRAP_READ_ONLY_KEY` are retired once a
  real admin credential exists**: a usable admin key in the key store,
  `adminSecret`, or `auth.keys`. Previously they stayed valid as long as the
  key store was empty, so deployments using `adminSecret` or `auth.keys` kept a
  live admin backdoor. They still work on a first run with nothing configured,
  and inference-only store keys no longer retire them. The gateway logs
  `[auth] ... disabled: <reason>` when they are refused.
- **MCP stdio servers no longer inherit the gateway's environment** (S3-3).
  They get a small allowlist (`PATH`, `HOME`, `LANG`, `TMPDIR`, ...) plus their
  own `env`. New per-server option `inheritEnv`: a list of extra variable names
  to pass through, or `true` for the old full inheritance.
  *Migration:* a server that relied on an inherited variable needs it in `env`
  or `inheritEnv`.

### Fixes

- **CORS preflight reflects the requested headers** (B3-8). It allowed only
  `Content-Type`, `Authorization` and `X-Request-Id`, so browser calls through
  the official openai SDK (`x-stainless-*`, `openai-organization`,
  `openai-project`, `openai-beta`) were blocked. The default now reflects
  `Access-Control-Request-Headers`; set `cors.allowHeaders` to restrict it.
  hono bumped to ^4.13.7.
- **MCP stdio servers are restarted after a crash** (B3-10). A server that
  fails to start or exits is reconnected with exponential backoff
  (1 s → 60 s), and each disconnect / attempt / recovery is logged. A
  `required` server that fails 5 consecutive attempts makes `/livez` return
  503. Failed servers now show up as `unready` in `/readyz` `mcpServers`
  instead of being missing.
- **word-filter compares text in NFKC + lower-case form** (S3-7). Compatibility
  characters (Kelvin sign, fullwidth letters, long s, ...) are now detected
  and redacted; redaction runs on the same representation as detection, and
  a word that is detected but cannot be redacted makes the request rejected
  instead of forwarded unchanged. Redacted text is forwarded in NFKC form
  (untouched when it contains no blocked word).
- **rate-limit plugin uses fixed-window counters** (S3-8 / C3-8). It kept
  every request timestamp of the last 24 h per key (even without a daily
  limit) and re-filtered the array on each request (O(n) CPU and memory, an
  event-loop DoS at high rpm). Now one minute counter per key, a day counter
  only when `maxRequestsPerDay` is set, and idle keys are evicted. Behavior
  change: windows are fixed (start at the key's first request), not sliding.
  The README's rate-limit section now documents the real config keys.
- **Per-IP rate limiter fixed and made opt-in** (B3-12). It read
  `c.env.server.requestIP`, which does not exist under `Bun.serve`, so every
  client shared one `"unknown"` bucket and the whole gateway was capped at
  20 req/s by an undocumented default. It now keys on the real peer address
  (`(c.env as Server).requestIP`, then `TRUSTED_PROXIES` forwarding headers),
  is **off unless configured** via the new `server.perIpRateLimit: { rps,
  burst }` (or `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST`, which take precedence;
  burst defaults to 2 × rps), sends `Retry-After` on 429, and evicts idle
  buckets. *Migration:* deployments that relied on the implicit 20 rps / 40
  burst must set it explicitly. README now documents every operational
  environment variable and the contents of the data directory.
- **Shutdown stops accepting connections before draining** (C3-7 / B3-9,
  remaining part; readiness 503 + refusing new work landed in 989c3ad).
  SIGTERM now flips readiness, calls `server.stop(false)` so no new
  connections are accepted, drains in-flight requests (responses get
  `Connection: close`), logs if the grace period runs out, then closes
  components.
