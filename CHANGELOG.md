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
- **Config validation is strict** (B3-11). `ai-gateway validate`, startup
  (`bootstrap()`) and `loadConfigFromObject()` share one validator
  (`validateConfig()` in `src/config/loader.ts`), and the embedded
  `new Gateway(config)` runs the same cross-reference checks:
  - unknown or misspelt keys are errors at every level, with the closest
    valid key (`unknown key "circuitbreaker" (did you mean
    "circuitBreaker"?)`) instead of being silently dropped (a typo used to
    mean no breaker, retry, timeout, admin secret or client keys);
  - removed keys say what to use instead
    (`observability.exporters was removed in 0.2.0 …; use observability.tracing`);
  - `strategy.targets`, `strategy.weights` keys and `strategy.rules[].target`
    must name existing targets; target names must be unique (a duplicate used
    to silently replace the first);
  - a target with no usable base URL (unknown provider, or `cloudflare` /
    `databricks`, without `baseURL`) fails validation instead of passing
    `validate` and crashing `serve`.
  Errors list every problem with its path. `AI_GATEWAY_*` overrides now
  resolve against the schema: camelCase keys work
  (`AI_GATEWAY_MAX_REQUEST_BYTES` → `maxRequestBytes`), array fields are
  comma-separated, string fields stay strings, and a variable that names no
  config key is ignored with a warning (it cannot trip the strict schema).
  *Migration:* run `ai-gateway validate -c <config>` and fix or delete each
  reported key.
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
- **One error model for every endpoint** (`src/core/errors.ts`). Error bodies
  no longer name the target or the upstream URL (`code: "provider_<target>"`,
  `type: "provider_error"` and `[target] …` messages are gone); the target is
  in the new `X-Gateway-Target` response header. Status / code changes:
  upstream 4xx keep the upstream `code`/`type`/`param`/`message`; upstream
  429 → 429 with the upstream `Retry-After`; upstream 5xx → 502 (was the
  upstream status); upstream 401/403 → 502 `upstream_auth_failed` (was
  401/403); network errors → 502 `upstream_unavailable` with a fixed message
  (was `fetch failed: …` including the URL); a 2xx body that is not JSON or
  has non-object `choices` → 502 `upstream_invalid_response` (was 500);
  `rate-limit` and `budget` plugin rejections → 429 (was 403, rate-limit adds
  `Retry-After`); open circuit → 503 `circuit_open` with `Retry-After`; local
  concurrency queue full → 429 `gateway_overloaded`; unknown failures → 500
  with a fixed message on every endpoint (completions used to echo the
  internal message). When several targets failed, the most meaningful error
  is reported instead of the last one (`FallbackExhaustedError` is unwrapped).
  Mid-stream SSE error events use the same shape. Plugins can set
  `status`/`retryAfterSeconds` on a `reject` result.
  (Closes B3-7, T3-12, round-2 "upstream 429/500 → 500" and "FallbackExhausted
  not unwrapped".)
- **Strategies only order targets; one executor runs them**
  (`src/core/executor.ts`, replacing the per-provider breaker / limiter /
  served-by decorators). Embedded API: `IStrategy` is now
  `{ mode, selectTargets(req) }`; `execute()`/`executeStream()` are gone from
  every strategy, strategy constructors take only their config, and
  `createStrategy(mode, config)` no longer takes a provider lookup (run
  candidates with `TargetExecutor` / `executeChat` / `streamChat`).
  `ConditionalStrategy.selectTargets()` now returns the execution order
  (matched target, then the default) instead of every rule target.
  `McpExecutor.executeAgenticLoop()` takes a `(ctx, req) => response`
  function (an object with `execute()` still works). Per-target `retry` now
  applies to every strategy, `single` included (it was ignored outside the
  multi-target strategies). A request whose deadline fires while queued for
  a target's concurrency slot leaves the queue at once and gets
  429 `gateway_overloaded` (it used to wait for a slot, call upstream with an
  aborted signal, answer 504 and count as a breaker failure — C3-3).

- **`/v1/completions` speaks the OpenAI legacy wire format** (T3-7). Snake_case
  parameters (`max_tokens`, `top_p`, `presence_penalty`, …) were silently
  dropped (so `max_tokens` never reached the upstream and max-token could not
  cap it) and the response was the internal camelCase chat object. Responses
  and stream chunks are now `text_completion` (`choices[].text`,
  `finish_reason`, legacy `logprobs`, snake_case `usage`). `echo: true`,
  non-empty `suffix`, `best_of` > 1 and batched prompts are rejected with 400
  (they were ignored, or an array prompt became several user messages).
- **Pass-through proxy forwards only allow-listed routes** (S3-6). New
  `passthroughProxy.routes` (`"METHOD /v1/path"`, `/*` suffix for sub-paths);
  default `POST /v1/responses`, `POST /v1/moderations`, `POST /v1/audio/*`.
  Other `/v1/*` routes get 403 `route_not_allowed` instead of being forwarded
  with the operator's upstream key (any client could list / read / delete the
  upstream account's files, stored completions, responses, batches…).
  Non-allowed methods on gateway routes (`GET /v1/chat/completions`, …) now
  answer 405 with `Allow`, proxy on or off.
  *Migration:* list any extra routes you proxy (e.g. `POST /v1/files`) in
  `passthroughProxy.routes`; add stateful routes only for single-tenant use.
- **max-token injects its cap when a request sets no limit** (T3-11). A request
  without `max_tokens` / `max_completion_tokens` used to run to the model
  default; it now gets `max_tokens: <maxTokens>`. The cap also applies to
  proxied bodies (`max_output_tokens` / `max_tokens` /
  `max_completion_tokens`, injected as `max_output_tokens` on `/v1/responses`).

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
- **`GET /admin/config` scrubbing closes the remaining gaps** (S3-5): URL
  userinfo and sensitive query values (`key`, `api_key`, `token`, `sig`, …) are
  redacted in `targets[].baseURL`, `observability.tracing.otlpEndpoint` and URL
  strings inside plugin config; every `mcpServers[].args` value is redacted; a
  value counts as an env template only if it is exactly one `${VAR}` (so
  `"${A}sk-literal${B}"` is redacted). The config history half of S3-5 went
  away with the history API.

### Added

- **Allow-listed wire pass-through** (T3-11, T3-9 fields), stream and
  non-stream: request `reasoning_effort`, `store`, `metadata`, `modalities`,
  `tools[].function.strict`, provider knobs (`top_k`, `thinking`, …) and
  message `reasoning_content`; response `reasoning_content` / `refusal` /
  `annotations`, `choices[].logprobs` (was always null), usage
  `*_tokens_details` and `cost`, and top-level `system_fingerprint`,
  `service_tier`, Perplexity `citations` / `search_results`. Full lists in
  `src/providers/wire-extras.ts`; unknown keys are still dropped.
- **Docker image** (`Dockerfile`): non-root (uid 1000), `tini` as PID 1,
  `HEALTHCHECK` on `/livez`, config at `/config/config.yaml`, data in `/data`.
  CI builds it and runs `scripts/docker-smoke.sh`.

### Fixes

- **Streaming lifecycle and SSE parsing hardened (T3-3, T3-4, T3-5, T3-10).**
  `data: [DONE]` from upstream ends the client stream at once (the upstream
  body is cancelled; anything sent after it is dropped). A stream that ends
  without `[DONE]` and without any `finish_reason` is reported as an SSE
  error event `upstream_stream_truncated` instead of a clean completion. A
  stream that yields no chunk, or a `200` with a JSON body on a stream
  request, is a failed attempt and fails over to the next target before any
  output; an upstream that ignored `stream: true` and answered with a
  `chat.completion` is converted to one chunk. The parser accepts `\r\n`,
  `\r` and `\n` line endings, scans incrementally, rejects a line/event over
  4 MiB (`upstream_event_too_large`), and treats malformed JSON
  (`upstream_invalid_response`) and `event: error` as errors; `choices:[null]`
  no longer throws. Any mid-stream error event is now sent **without** a
  trailing `data: [DONE]`, so clients can tell the answer is incomplete.

- Circuit breaker settlement is permit-based: `recordSuccess(permit)` /
  `recordFailure(permit)` only count while the breaker is still in the
  generation the permit was issued in. Requests admitted before an outage can
  no longer close a HALF_OPEN breaker without a probe, re-open it, or keep
  pushing the OPEN window forward (C3-6). Calls without a permit keep the old
  behavior.

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
- **SIGTERM exits within the shutdown grace even with a hung request.**
  The process used to keep running until the hung request hit
  `requestTimeout`: the HTTP listener was closed with a non-forced
  `server.stop()` and nothing exited the process. Now the non-forced stop
  still runs first (streams can finish within `SHUTDOWN_GRACE_MS`), connections
  left when the grace expires are force-closed (`server.stop(true)`), and the
  process exits once components are closed (a watchdog exits with code 1 if
  shutdown is still running grace + 5 s after the signal). Found by the e2e
  suite.
- **Shutdown stops accepting connections before draining** (C3-7 / B3-9,
  remaining part; readiness 503 + refusing new work landed in 989c3ad).
  SIGTERM now flips readiness, calls `server.stop(false)` so no new
  connections are accepted, drains in-flight requests (responses get
  `Connection: close`), logs if the grace period runs out, then closes
  components.
