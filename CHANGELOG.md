# Changelog

## Unreleased

### Added

- Browser e2e (0.3.0 P7): `bun run test:browser` runs Playwright (`@playwright/test`, devDependency only, Chromium)
  against the real server, one gateway per suite with a temporary data dir and an in-process fake upstream
  (`tests/browser/`, `playwright.config.ts`). Covers sign-in / lockout / sign-out / session end, zh / en, no console
  error and no CSP violation on any page, the channel wizard through to a served model, model drawer edit and binding
  reorder (buttons and drag) live as “版本 #N”, key create → plaintext once → `/v1` → usage → quota exhausted → raise /
  reset / revoke, `409` from two pages, field-level validation errors, usage charts, logs, Playground streaming and
  stop, a config change during a running stream, versions diff and rollback, audit, session revoke, CSRF. New CI job
  `browser` (uploads traces / screenshots on failure); releases reuse CI and so require it.
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects a system Chromium (arm64 Linux has no Playwright download).
- `bun run smoke:real` (`scripts/smoke-real-deepseek.ts`): opt-in smoke test against the real DeepSeek API (skipped
  without `DEEPSEEK_API_KEY`, never run in CI): Admin API channel, test, fetch models, publish, non-stream and stream
  chat through a key with a quota, usage counted, `403 quota_exhausted` after the admitted request finished,
  unpublished → `404`, over-limit `max_tokens` → `400`, account balance.
- `ServeOverrides.hostResolver` (embedders and test harnesses only; not reachable from the CLI, config file or
  environment): the DNS resolver behind the Admin API channels' SSRF guard. The guard's address rules are unchanged.

- Admin console rewrite (0.3.0 P6, plan §5, §9.3, §9.4): a Preact + Vite single-page app at `/admin/dashboard`,
  built at build time and embedded into the server (`src/dashboard/assets.generated.ts`), so binaries and the Docker
  image serve it with no files on disk and no new runtime dependency (preact, vite, @preact/preset-vite and happy-dom
  are devDependencies). Pages: 概览 (trends, channel health), 渠道 (status, latency, key states ok / cooling /
  disabled, account balance, add wizard preset → keys → test → fetch models → publish, key management, key strategy,
  cooldown), 模型 (table + drawer: metadata, drag-to-reorder binding priority groups, weight, balance mode,
  strategy), 密钥 (allowed models, token quota, RPM / TPM, expiry, plaintext once with copy, usage, raise quota, reset
  usage), 用量 (by key / model / channel, date range, time zone, charts), 日志, Playground (real routing, streaming),
  设置 (aliases, global rate limit, plugins, model source, sessions), 版本与审计 (diff, rollback, audit). Chinese /
  English UI (browser default, switch saved in `localStorage`). Every save shows “已生效 · 版本 #N”, validation errors
  are placed on their fields (config API `400`s now list `fields[]`), `409` shows “已被修改，请刷新”, every write sends
  `If-Match`. `bun run console:build` / `console:dev` / `console:typecheck`; CI fails when the embedded build is
  stale, the Dockerfile rebuilds it, the release workflow builds it before compiling.
- Console sessions (plan §9.4): `POST /admin/session/login` exchanges an `admin` / `read_only` key (or the
  `adminSecret`) for an in-memory server-side session — `HttpOnly; SameSite=Strict; Path=/admin` cookie, `Secure` on
  https, 12 h lifetime + 60 min idle timeout — with a double-submit CSRF token required on every cookie-authenticated
  write (on top of the P4 Origin / `Sec-Fetch-Site` / JSON-only guard). Login failures lock a client IP out (5 → 15
  min) with a global cap; `GET /admin/session`, `GET /admin/sessions`, `DELETE /admin/sessions/:id`, `POST
  /admin/session/logout`; sign-ins, sign-outs, revocations and failures are audited (never the key). Sessions follow
  their key (revoked / expired / scope removed → ended). New config block `console:` (`sessionTtlMinutes`,
  `idleTimeoutMinutes`, `maxLoginFailures`, `lockoutMinutes`, `secureCookie`). Bearer / `X-Admin-Secret` access is
  unchanged; `/v1/*` never reads the cookies and the inference path gains no database read.
- `GET /admin/channels/:id/balance` (user decision): upstream account balance for DeepSeek (`/user/balance`) and
  OpenRouter (`/credits`), fetched on demand with the channel key behind the SSRF guard, timeouts and a rate limit;
  never stored, no cost computed (the gateway still has no prices anywhere). Other presets: `supported: false`.
- `POST /admin/playground/chat/completions` (admin): the console Playground's chat completion through the real
  routing, usage recorded as `console-playground`.

- Per-key limits and usage statistics (0.3.0 P5, user decisions 2026-11-02; `docs/admin-api.md#key-limits-and-usage`).
  The gateway has one owner and no money anywhere: client keys get a **token quota** (`quotaTokens`, all-time
  prompt + completion tokens until reset; `null` = unlimited), their own **RPM** and **TPM** (unset → the
  `rate-limit` plugin's values; new plugin option `maxTokensPerMinute` / `tpm`). Key store migration 6 (`quota_tokens`,
  `rpm`, `tpm`, `used_tokens`, `usage_reset_at`, `revision`). New: `PATCH /admin/keys/:id` (If-Match, 428/409, strict
  body), `POST /admin/keys/:id/reset-usage`, limits on `POST /admin/keys` and `ai-gateway keys create --quota-tokens
  --rpm --tpm`; key views carry `usedTokens`, `remainingTokens`, `quotaExhausted`, `usageResetAt`, `revision` (ETag).
  Every key write is audited (with the config store). A key at or over its quota is refused before the request
  starts with `403 quota_exhausted`; admitted requests always finish (streams are never cut), so the last ones may
  overshoot; keys with a quota get `403 quota_not_metered` on image generation and pass-through routes; RPM / TPM →
  `429 rate_limit_exceeded` + `Retry-After`. All checks use in-memory counters (no database access on the request
  path), shared across config reloads, persisted asynchronously (~1 s, `USAGE_FLUSH_INTERVAL_MS`, and on shutdown) and
  restored at startup.
- `GET /admin/usage?groupBy=key|model|channel&from&to&tz&daily` (read_only): requests, errors, input / output /
  cache-hit / reasoning tokens, average and max latency, from hourly UTC rollups in `<data dir>/usage.sqlite` (batched
  WAL writes, flushed before each read); days follow any IANA `tz` (default UTC). The request log gained `keyId`,
  `publishedModel`, `tokens.cacheHit` / `tokens.reasoning` (stdout) and `keyId`, `cacheHitTokens`,
  `reasoningTokens`, `durationMs`, `status` columns (`/admin/logs`, request-log migration 3).

- Runtime-config Admin API (0.3.0 P4, `docs/admin-api.md`): `/admin/channels` (+ keys, `test`, `fetch-models`),
  `/admin/models` (+ `PUT …/bindings`), `/admin/settings`, `/admin/config/versions` (+ `rollback`),
  `/admin/audit`, `/admin/presets`. Writes need the `admin` scope (`read_only` may read), strict JSON bodies,
  `If-Match` with the resource revision (missing → 428, stale → 409) and pass a CSRF guard (cross-site → 403,
  non-JSON → 415). Each write is one transaction — resource, config version (key ciphertext only), audit row, a
  fully validated runtime swapped in via `Gateway.reload` — or nothing (`422 config_invalid` with the reason, old
  config keeps serving); the database is backed up with `VACUUM INTO` before each change (newest 5 kept,
  `CONFIG_BACKUP_MIN_INTERVAL_MS`). Upstream keys are only ever shown as hints. `runtimeConfig.source: file` makes
  every write `403 config_read_only`. `GET /admin/config` now shows the live config.
- SSRF guard (user decision 2026-11-02): base URLs written through the Admin API must be public internet addresses
  (loopback, private, link-local / cloud metadata, CGNAT, reserved, IPv6 equivalents incl. IPv4-mapped / NAT64 /
  6to4, local names, names resolving to any of these, credentials in the URL or query are refused) and are
  re-checked against DNS before every upstream call (rebinding) without following redirects. Channel probes are
  rate limited (10/min per caller, 30/min total), time out after 10 s and read at most 2 MiB.
- Several upstream keys per target (0.3.0 P4): `apiKeys` (strings or `{ key, weight, enabled }`), `keyStrategy`
  `round_robin` | `weighted` | `fill_first`, `keyCooldownSeconds`. Upstream 429 cools the key down (Retry-After,
  capped at 1 h) and retries the request with the next key; 401 / 402 disables the key (status `invalid` / `quota`,
  error recorded, persisted asynchronously, audit `key_auto_disabled`); the channel fails over only when no key is
  left. All key state is in memory and survives reloads; `Gateway.onKeyEvent()` reports it.
- Channel load balancing per published model (0.3.0 P4): bindings form priority groups (the next group only when
  every channel of the group is unavailable or failed) and `models[].balance` picks within a group: `weighted`
  (default), `round_robin`, `least_inflight`. Targets and bindings take `enabled: false`.
- Runtime config store (0.3.0 P1): `targets`, `strategy`, `aliases`, `plugins` and `compatibility` now live in
  `<data dir>/config.sqlite` (channels, channel keys, models, bindings, settings, config versions, audit log), imported
  from the config file on the first start. Later starts use the store and warn when the file's runtime sections changed
  (they are ignored). `runtimeConfig.source: file` keeps the file as the only, read-only source.
- Upstream keys are encrypted at rest with AES-256-GCM (WebCrypto) under a key derived with HKDF-SHA256 from
  `GATEWAY_SECRET_KEY`, bound to their channel; `"${VAR}"` references are stored as references. Rotation via
  `GATEWAY_SECRET_KEY_PREVIOUS`. Store files are created `0600`; existing databases are backed up before a migration.
- CLI: `ai-gateway config import [--force]` and `ai-gateway config status [--json]`.
- Published models (0.3.0 P2): optional `models:` section — public model names, each bound to one or more targets
  with a per-binding upstream model name, `fallback` (priority) or `loadbalance` (weight) routing, `enabled`,
  display name and metadata. Stored in the config store. Per-key `allowedModels` (key store migration 5; CLI
  `keys create --models`, admin API `allowedModels`). `GET /v1/models` lists only what the calling key may use, with
  metadata extension fields.
- Model metadata enforcement (0.3.0 P3): requests are checked against the published model's metadata before
  leaving the gateway (output limit, estimated context window, input types, tools, parallel tools, structured
  output, logprobs, web search, reasoning efforts) and rejected with 400 and a specific `code`/`param`, never
  clamped. Lossless rewrites: developer -> system (default), system merged into the first user message,
  `reasoning.map` (effort -> upstream params, e.g. DeepSeek `thinking`), binding `params`. Known upstream models
  (`src/core/model-presets.ts`: DeepSeek flash / v4-pro from its /models list) fill unset metadata, and a published
  model promising more than a known upstream is a config error.
- `Gateway.reload(config)` (0.3.0 P0, live config): assembles a new runtime snapshot and swaps it in atomically.
  Requests and streams in flight finish on the snapshot they started on; an invalid config throws and the old
  snapshot keeps serving; breakers, concurrency limiters and plugins with unchanged config keep their state;
  `mcpServers` is startup-only (`ReloadRejectedError`). Also `currentSnapshot()`, `onReload(listener)`, and
  `registerProvider` / `registerPlugin` registrations now survive reloads. Not yet exposed over HTTP.

### Breaking changes

- **Red team 2026-11-02 fixes** (`docs/admin-api.md`):
  - **RC1 / RC2:** `PATCH /admin/channels/:id` that moves a channel with stored keys to another origin (scheme, host
    or port; also via `preset` or `baseURL: null`) must carry `apiKeys` for the new address, else
    `400 api_keys_required_on_base_url_change`; `apiKeys` replaces every stored key. *Migration:* scripts that only
    PATCH `baseURL` to a new host send the key(s) in the same request.
  - **RB6:** new runtime section `limits.maxOutputTokens` (default **65536**; config file `limits:`,
    `PATCH /admin/settings`, console 设置 → 请求上限). On a published model without `metadata.maxOutputTokens` a
    larger `max_tokens` / `max_completion_tokens` is now `400 max_tokens_exceeded` (was forwarded as is).
    *Migration:* raise `limits.maxOutputTokens` or give the model its own `maxOutputTokens`.
  - **RB3:** a key with a quota or TPM may now get `429 quota_in_flight` (`Retry-After: 1`) while its requests in
    flight reserve the rest of the quota; TPM also counts in-flight reservations (`429 rate_limit_exceeded`,
    `Retry-After: 1`). Clients should retry on 429 as usual.
  - **RB5:** an upstream `Retry-After` no longer cools a key for longer than the channel's `keyCooldownSeconds`
    (default 30; was up to 1 h), the cooldown is soft (a channel without another usable key still uses the cooling
    key instead of answering `429` locally), and `429` is no longer a circuit-breaker failure.

- **P5: no prices or money anywhere (user decision 2026-11-02).** The `budget` plugin is deleted: any `budget` entry in
  `plugins` (enabled or not, also in the config store's settings) fails validation with "the budget plugin was removed
  in 0.3.0 …" — *migration:* remove it and give client keys a `quotaTokens`. `targets[].costPer1kInputTokens` /
  `costPer1kOutputTokens` (and channel `settings` of the Admin API) are rejected with a removal hint — *migration:*
  delete them; the config store migration 3 drops them from stored channels (and the unused `models.pricing_json`
  column), and rollbacks to older versions drop them too. The Prometheus counter `ai_gateway_request_cost_usd` is
  gone, and an upstream's `usage.cost` / `cost_details` are no longer passed through to clients. `core/usage.ts`
  no longer exports `costOf` / `hasCostRates` / `CostRates`; `BudgetPlugin` / `BudgetConfig` are no longer exported;
  `buildPluginsFromConfig` takes no `targets` argument.
- P5: the `rate-limit` plugin's `maxRequestsPerMinute` is no longer required when `maxRequestsPerDay` or
  `maxTokensPerMinute` is set (at least one is). A key-store key with its own `rpm` is no longer limited by the
  plugin's per-minute value.

- P4: a target needs `apiKey` or `apiKeys` (as before, a target without a key is a config error). A single-key
  target that gets an upstream 429 now pauses that key for the Retry-After time (default 30 s): meanwhile its
  requests answer `429` with the remaining Retry-After (or fail over to another target) instead of being sent
  upstream; a 401 / 402 disables the key until an operator re-enables it (`503 no_upstream_key` when it was the
  last one; with the file source the disable lasts until restart). Under `strategy: fallback`, bindings with the
  same `priority` now share a group and are balanced by weight (previously: list order), and `weight: 0` drains a
  binding in every mode. A model whose bindings are all on disabled targets is no longer dropped from the config
  store's published list: it answers `503 model_unavailable` (its aliases too) instead of `404`.
- P4: every state-changing `/admin/*` request with a body must send `Content-Type: application/json`, and writes
  from a foreign `Origin` are refused.
- P4: embedded callers (`gateway.route()` etc.): when every key of a target is unusable the call throws
  `NoUsableKeyError` (HTTP: 429 / 503 as above).

- Requests that exceed a published model's limits or ask for a feature it lacks are rejected with 400 (P3, user
  decision 2026-11-01), including limits filled in from known upstream models. `developer` messages are now always
  sent as `system` to providers without the role (DeepSeek answered 422), in every compatibility mode. DeepSeek
  targets no longer drop/warn on `logprobs` (supported per QA 2026-10-19).

- Only published models are served (user decision 2026-11-01): any other model name is rejected with
  `404 model_not_found` explaining why, before reaching an upstream. Without a `models:` section, the names in
  `targets[].models` are published and a request goes only to targets that list its model (previously every
  request followed the global strategy regardless of `targets[].models`). A target without a `models` list
  serves nothing. Restricted keys get `403 model_not_allowed` for any model outside their list. `/v1/models`
  `owned_by` is the first serving target. Aliases in an explicit `models:` config must point to published models.

- The runtime sections of the config file are imported once into `<data dir>/config.sqlite` and ignored afterwards
  (startup warns when they change); re-import with `ai-gateway config import --force`, or set
  `runtimeConfig.source: file` to keep the 0.2.0 behaviour.
- A literal upstream `apiKey` now requires `GATEWAY_SECRET_KEY` (startup refuses without it), and
  `GATEWAY_ENV=production` with the database source always requires it. The Docker smoke test passes one.

Configs that relied on keys or values that were accepted but had no effect
now fail `ai-gateway validate` and startup with a migration hint:

- **`observability.tracing.otlpProtocol: grpc` is rejected.** Only the
  OTLP/HTTP exporter exists; `grpc` was silently exported over HTTP.
  *Migration:* remove `otlpProtocol` (or set `http`) and point `otlpEndpoint`
  at the collector's OTLP/HTTP traces URL (usually `http://<host>:4318/v1/traces`).
- **`targets[].priority` and `targets[].budget` are rejected** (never read by
  any strategy or plugin, and not in the Go original). Removed from
  `TargetConfig`. *Migration:* order targets with `mode: fallback` and
  `strategy.targets`; limit client keys with a token quota (`quotaTokens`, P5 — the `budget` plugin
  this hint used to point to was removed in P5).
- **Built-in plugin configs are strictly validated** (`rate-limit`, `cache`,
  `budget`, `word-filter`, `max-token`, like `pii-secret-guard` already was):
  unknown keys (with a did-you-mean hint), wrong types, missing required
  settings, a `word-filter` `mode` other than `reject` / `redact`, two aliases
  of the same option, and non-integer counts are errors. The embedded
  `new Gateway(config)` throws on the same problems. *Migration:* remove the
  keys the error names (they were ignored before, e.g. word-filter
  `caseSensitive`, max-token `maxMessages`, rate-limit `requestsPerSecond` /
  `burst`).
- **Durations use one parser.** `requestTimeout` and
  `tracing.shutdownGrace` accept `<int><unit>` terms with units `ms`, `s`,
  `m`, `h`, including compounds (`1m30s`); zero (`0s`) is rejected.
  `requestTimeoutMiddleware()` throws on an invalid string instead of
  misreading it.

### Fixed

- **Console: clearing an optional field did not save** (review 2026-11-02 U3 / U4). The model drawer left an empty
  display name / description out of the `PATCH` and the channel drawer did the same with an empty 429 cooldown, so the
  old value stayed while the console said “已生效”. A cleared field is now sent as `null`: the display name and
  description are cleared, `keyCooldownSeconds` goes back to the default (30 s). The server also stores an empty or
  blank `displayName` / `description` as `null` (create and `PATCH`). Checked the other optional fields of the same
  drawers: model metadata (sent whole), base URL (already `null`), key limits / expiry / allowed models (already
  `null`) and settings `limits` (already `null`) were correct; bindings are replaced whole.
- **A response without usage was counted as 0 tokens: unlimited quota** (red team 2026-11-02 RB1, 严重). PoC: quota
  1000, 30 non-streaming requests to an upstream that omits `usage` → all 200, 30,240 tokens billed upstream, 0
  counted. A missing or implausible usage (absent, all zero, negative / NaN, zero completion with output) on chat,
  completions and embeddings — per upstream call, every MCP round, and streams with such a usage chunk — is now
  replaced by the shared CJK-aware estimate, and the request log marks `usageEstimated`.
- **Quota check-then-act race** (RB3, 高). PoC: quota 1000, 40 concurrent requests of 309 tokens on a slow upstream
  → all 200, 12,320 tokens (12×). Admitted requests now hold an in-memory reservation (estimated prompt + output
  cap) until they settle; a request is admitted only while used + reserved < quota (else `429 quota_in_flight`), so
  the overshoot is bounded by about one request. Released exactly once on success, error, cancel, failover and
  rejection; a reservation that is never settled (e.g. a stream iterator dropped without `return()`) expires after
  max(`requestTimeout`, `server.streamMaxDurationSeconds`) + 60 s, or 1 h when streams are unbounded, swept lazily on
  the key's next request (no timer, no database read).
- **One client's upstream 429 took the shared key down for everyone** (RB5, 高). PoC: one `429` with
  `Retry-After: 120` → every client got `429` on the channel for two minutes, repeatably; five 429s also opened the
  breaker. Now a soft cooldown capped at `keyCooldownSeconds`, ended by a success, and not a breaker failure.
- **Unbounded `max_tokens` on models without metadata** (RB6, 高). PoC: `max_tokens: 9999999` forwarded, 10,000,007
  tokens billed by one request. Now `400 max_tokens_exceeded` above `limits.maxOutputTokens` (default 65536).
- **Admin could exfiltrate stored upstream keys** (RC1 高 / RC2 中). PATCH `baseURL` to any public host, then
  `test` / `fetch-models` / `balance` sent the decrypted key (or the resolved `${VAR}`) there. A change of origin now
  requires the keys again (`apiKeys`, replaces all); probes use only the saved base URL and keys; the audit entry
  records `originChange` / `keysReplaced` (hints only); the console asks for the new key(s).
- **Streams were metered by an estimate, Chinese text undercounted 2.5–6x** (review 2026-11-02 C4). The gateway
  only asked the upstream for a usage chunk when the client sent `stream_options.include_usage` (the OpenAI SDK
  does not by default), and estimated ~4 characters per token otherwise: 620 real tokens of Chinese output were
  counted as 101 against the key's quota, TPM and usage stats. Now every streaming chat / completions request asks
  the upstream for usage on providers that support `stream_options` (not Mistral, AI21, Ollama, Replicate,
  Cloudflare, Hugging Face), and usage is kept off a client stream that did not ask for it (a usage-only chunk
  with `choices: []` is dropped, a `usage` field on a content chunk — DeepSeek's style — removed), so what clients
  see is unchanged. Behaviour change: such a client no longer gets usage that an upstream sent unasked. The estimate is now only a fallback (upstream sent no usage) and is CJK-aware (one token
  per CJK character, other text UTF-8 bytes / 4, plus tools and tool-call arguments); the model policy's
  context-window check uses the same estimator (`core/usage.ts estimateTextTokens / estimatePromptTokens`).
- **Any client could disable the operator's upstream key with a 402** (review 2026-11-02 C7). Every upstream `402`
  disabled the key for good, but some 402s are about the request (OpenRouter: "requires more credits, or fewer
  max_tokens", credit held by in-flight requests), so one guest request with a large `max_tokens` turned a
  single-key channel into `503 no_upstream_key` for everyone until an admin re-enabled the key. This refines the
  0.3.0 “401/402 auto-disable” decision (intent: dead key / exhausted balance): a `402` now cools the key down like
  a `429` (`Retry-After` capped at `keyCooldownSeconds`) but softly — a channel with no other usable key
  still uses it — and is not a breaker failure; it fails over to the next channel, and reaches the client as `402`
  when none is left. The key is disabled (`quota`) only after 3 consecutive account-level `402`s within an hour
  with no success in between; a `402` whose message names the request never counts. `401` still disables at once.
- **Console: saving a key allowed NO models widened it to ALL models** (review 2026-11-02 U2). The key form sent
  `allowedModels: null` whenever no model was checked, so a key created with `allowedModels: []` became
  unrestricted when any other field was edited. The form now has an explicit choice — 全部模型 / All models (`null`)
  or 仅限勾选的模型 / Only the checked models (a list, `[]` = none, with a warning) — and round-trips `[]`; models the
  key allows that are no longer published stay listed and kept. The keys table shows “无（不能调用任何模型）” for
  `[]`. The server already distinguished omitted / `null` / `[]` (now documented and tested).
- **Console: a model save could be half-applied** (review 2026-11-02 U5). The model drawer saved with `PATCH
  /admin/models/:id` and then `PUT /admin/models/:id/bindings`; when the bindings were rejected the field change was
  already live and a retry answered `409`. `PATCH /admin/models/:id` now also accepts `bindings` and applies fields
  and bindings in one transaction (one config version, all or nothing), and the drawer saves with that single
  request. `PUT …/bindings` is unchanged.
- A base URL refused by the SSRF guard (`422 unsafe_base_url`) now carries `fields: [{ path: "baseURL" }]`, so the
  console shows the refusal on the Base URL field instead of only in a toast (found by the P7 browser e2e).
- **Chat content parts `input_audio`, `file` and assistant `refusal` are accepted** and forwarded verbatim (they were rejected with 400 although valid OpenAI input). Other unknown part types are still rejected, so text cannot bypass word-filter or the PII/secret guard.
- **SIGTERM cut every in-flight stream.** The drain counted a request as
  finished when its handler returned the SSE `Response`, before the body was
  written, so the drain ended at once and the forced close reset all
  streaming connections (200 of 200 in-flight streams ended with
  `ECONNRESET` in a load test). Streamed bodies (SSE, NDJSON, proxied audio /
  octet streams) now stay in flight until they finish or the client cancels,
  within `SHUTDOWN_GRACE_MS`.
- **Request-log SQLite throughput.** `request-logs.sqlite` used the default
  rollback journal with `synchronous=FULL` and no busy timeout: one
  synchronous fsync-heavy commit per request capped the whole gateway at
  ~100 req/s on a network volume, and any other writer made inserts fail
  with "database is locked". It now uses WAL, `synchronous=NORMAL`, a 1 s
  busy timeout and a cached insert statement (same volume: ~7 ms → ~1 ms per
  insert).
- **Streaming `X-Gateway-Provider` carried the upstream's `model`** instead of
  the target name, and the `ai_gateway_requests_total` /
  `ai_gateway_request_duration_seconds` `provider` label is read from that
  header (an upstream-controlled label value). It is the target now;
  `/v1/completions` (stream and non-stream) sets the header too.
- **Explicit `null` optional parameters were rejected with 400.** The OpenAI
  API and DeepSeek treat `"temperature": null`, `"tools": null`,
  `"stop": null`, a message's `"name": null` … as "not set"; so do
  `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` and
  `/v1/images/generations` now.
- **Estimated stream usage ignored reasoning text.** When a stream has no
  usage chunk, completion tokens are estimated from the streamed text (so the
  `budget` plugin cannot be bypassed); `delta.reasoning_content` /
  `delta.reasoning` / `delta.refusal` were not counted, so a reasoning
  model's thinking was free for the budget and missing from token metrics.
- Upstream errors were written to the request log (`/admin/logs`) with
  provider `unknown`; they carry the failing target, like the
  `X-Gateway-Target` header.
- README: `X-Gateway-Overhead-Ms` is the time until the gateway had the
  response (including the upstream call; time to first chunk for streams),
  not gateway-only processing time.

- `requestTimeout: "500ms"` passed validation but the timeout middleware,
  which had its own parser without `ms`, read it as 500 minutes. Validation
  and runtime now share `config/duration.ts`; `1m30s`, which the middleware
  understood but the schema rejected, is accepted.
- MCP: the agentic-loop depth was taken from the first `mcpServers` entry
  only. It is now the smallest `maxCallDepth` set on any server (servers
  without it do not count; default 5), as in the Go original. The schema no
  longer fills in `maxCallDepth: 5` per server.
- `config.example.yaml` configured rate-limit with `requestsPerSecond` /
  `burst` (never read) and `config.example.json` used the removed `logger`
  plugin; both now use `maxRequestsPerMinute`. The example OTLP endpoint is
  the full `/v1/traces` URL.

### Removed

- The 0.2 vanilla-JS console (`src/dashboard/static/console.{js,css}`, `/admin/static/*`, `/admin/dashboard/login`,
  `/admin/dashboard/config`) and its `sessionStorage` admin-key sign-in; `/admin/dashboard` now serves the new console
  and `/admin` redirects there.
- `src/dashboard/static/dashboard.js` and `style.css`, unserved leftovers of
  the pre-0.2.0 placeholder dashboard.

### Documentation

- README / README_CN: Architecture, Request Flow and Project Structure describe
  the 0.2.0 pipeline (`core/pipeline.ts`, `core/executor.ts`, surfaces) instead
  of the pre-refactor `Gateway.route()` flow; config reference, Admin API,
  plugin, tracing, metrics and CLI sections corrected against the code.
  PLAN.md reflects the v0.2.0 state.

## 0.2.0 (2026-10-18)

### Breaking changes

- **The bootstrap admin key can no longer be revived by revoking admin keys.**
  An existing key store that already contains any admin-scoped key (active,
  revoked or expired) is latched on upgrade, and `ADMIN_BOOTSTRAP_KEY` /
  `ADMIN_BOOTSTRAP_READ_ONLY_KEY` are refused from then on.
  *Migration:* remove the variables from the environment. If no admin
  credential works any more, run `ai-gateway keys create --admin -c config.yaml`
  on the gateway host (see Added). `clientCredentialWarning()` now takes a key
  store with `isEmpty()` and `isBootstrapLatched()`.
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

- **`observability.metrics` is honored** (B3-6, 2.3). `enabled: false` stops
  serving `/metrics`; `port` other than `server.port` serves `/metrics` on its
  own listener (metrics only, no auth); without a `metrics` block `/metrics`
  stays on the main port. `port` no longer defaults to 9090 (so
  `enabled: true` alone keeps the main port).
  *Migration:* if you had `enabled: false` and scraped `/metrics` anyway,
  set `enabled: true`.
- **Budget reserves before and settles after** (C3-5, 3.6). A request
  reserves its estimated cost (prompt + `max_tokens`, or the new
  `reserveOutputTokens`, default 1024) and is charged its actual cost; while
  other requests of the key are in flight it is admitted only if the estimate
  fits next to their reservations (50 concurrent $1 requests against a $1
  budget: 1 succeeds, was 50). A budget with no cost rates (none on the
  plugin, and some target without `costPer1k*Tokens`) is a config error;
  without plugin rates the serving target's rates are charged. The 429 reason
  includes in-flight reservations.
  *Migration:* add `costPer1kInput` / `costPer1kOutput` to the budget plugin,
  or `costPer1kInputTokens` / `costPer1kOutputTokens` to every target.
- **Request-log entries carry `surface` and `status` on every request**, and a
  failed request is logged once with the provider that failed (was
  `"unknown"`). `McpCallDepthError` is now a `GatewayError`.

### Security

- **Console page shells under `/admin/dashboard` no longer require admin
  auth**: they carry no data, and all data comes from the authenticated admin
  API. The CSP header the old dashboard sub-app set on every response
  (including `/v1/*`) is now limited to console pages and assets.
- **`GET /admin/keys` (list) is open to `read_only`**, like every other admin
  GET (`GET /admin/keys/:id` already was). It never returns plaintext; create,
  update, delete, revoke and rotate stay `admin`-only.

- **`ADMIN_BOOTSTRAP_KEY` / `ADMIN_BOOTSTRAP_READ_ONLY_KEY` are retired once a
  real admin credential exists**: an admin key has been created in the key
  store, `adminSecret`, or `auth.keys`. Previously they stayed valid as long as
  the key store was empty, so deployments using `adminSecret` or `auth.keys`
  kept a live admin backdoor. They still work on a first run with nothing
  configured, and inference-only / `read_only` store keys do not retire them.
  The gateway logs `[auth] ... disabled: <reason>` when they are refused.
- **One-way bootstrap latch.** The key store records (new `api_key_meta`
  table, migration v4) the moment the first admin-scoped key exists, created
  through the bootstrap key or otherwise (`POST /admin/keys`, a `PUT` granting
  `admin`, or `ai-gateway keys create --admin`), in the same transaction as the
  key write. Once latched the bootstrap keys are refused for good (401, same
  body as an invalid credential), even if every admin key is later revoked,
  expires or is deleted; before, they silently came back as a full admin
  credential. Writes made with a bootstrap credential re-check the latch inside
  their transaction, so of two concurrent bootstrap requests creating an admin
  key only one succeeds. If `ADMIN_BOOTSTRAP_KEY` is still set while latched,
  startup logs one warning (`permanently disabled ... remove them from the
  environment`). `adminSecret` / `auth.keys` behaviour is unchanged.
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

- **Release artifacts**: tagged releases publish a multi-arch Docker image
  (`ghcr.io/brokenstring314/ai-gateway`, linux/amd64 + linux/arm64) and
  standalone `bun build --compile` binaries for linux-x64, linux-arm64,
  darwin-x64, darwin-arm64 and windows-x64 with `SHA256SUMS`. The admin
  console's static assets are now embedded in the build instead of read from
  `src/dashboard/static` at runtime, so the binary needs no source tree.
- **`ai-gateway keys create|list|revoke`**: manage the API key store directly
  (`<data dir>/api-keys.sqlite`, data dir = `--data-dir`, `GATEWAY_DATA_DIR` or
  `./.data`, as for `serve`), with the server stopped or running. `keys create
  --admin [--name N] [--expires ISO] -c config.yaml` is the admin recovery path:
  it prints the new key once on stdout (`--json` for scripts) and nothing else
  secret; diagnostics go to stderr. The key store database now uses WAL mode
  and a 5 s busy timeout so the CLI and the server can write concurrently.
- Licensed under Apache-2.0 (`LICENSE`); `NOTICE` credits Ferro Labs AI Gateway (Apache-2.0), whose design this project derives from. Both files are shipped in the Docker image.
- **Admin console** at `/admin/dashboard` replaces the placeholder dashboard
  (which rendered fixed demo numbers). Four pages backed by the admin API:
  Overview (readiness, per-target circuit breakers, `upstreamAvailable`, MCP
  server states, request counts / error rate / latency), API keys (list;
  admins create with scopes and expiry, see the new key once, rotate,
  revoke), Request logs (paginated, filter by surface, target, model, status,
  time) and Config (scrubbed, read-only). Sign-in takes an `admin` or
  `read_only` key, kept in `sessionStorage` and sent as Bearer (no cookies).
  Server-rendered shell plus one vanilla JS file and one CSS file from
  `src/dashboard/static`, strict CSP (`script-src 'self'`, no inline script),
  API data inserted as text only, no external assets. Removed the placeholder
  Providers, Analytics, Playground and Getting started pages and
  `/admin/static/style.css` / `dashboard.js`.
- `GET /admin/status`: caller scopes, circuit breakers, `upstreamAvailable`,
  MCP states and an in-process request summary (`Metrics.requestSummary()`).
- `GET /admin/logs` and `/admin/logs/stats` accept `status=error|ok`.
- **`pii-secret-guard` plugin** (guardrail): detects secrets (`sk-` /
  `sk-ant-` keys incl. DeepSeek-style, AWS access/secret keys, GitHub, Slack,
  Google, Stripe, JWT, PEM private keys, high-entropy `api_key=` /
  `password=` assignments) and PII (email, phone incl. CN mobile and E.164,
  CN ID with check digit, credit card with Luhn, IBAN, US SSN, opt-in IPv4)
  in chat, completions, embeddings and pass-through requests (content
  strings, content parts, tool-call arguments; NFKC + zero-width stripped).
  Per default / category / entity action: `block` (400 `secret_detected` /
  `pii_detected`, value never echoed), `redact` (typed placeholders such as
  `[EMAIL]`, `[SECRET:github_token]`; blocked on pass-through) or `log`.
  Allowlist, custom patterns, surfaces, roles, optional non-streaming
  response scanning (422; streaming responses are not scanned). Request log
  `guardrail` records carry entity types only; new metric
  `guardrail_detections_total`; response blocks count in
  `plugin_blocked_total{outcome="response_rejected"}`. Strict config schema
  checked by `validate`. Design adapted from ferro-labs/ai-gateway
  `pii-redact` / `secret-scan` (Apache-2.0).
- Plugin rejections can carry their own OpenAI error `code` / `type`
  (`PluginResult` reject `code` / `type`, `PluginRejectionError.details`);
  the default stays `plugin_rejected` / `plugin_rejection`.
- Plugin metadata `_surfaceName` (chat, completions, embeddings, images,
  passthrough) and `_streaming` are set for every request.

- `Gateway.execute(surface, req, ctx)` and `Gateway.executeStream(surface,
  req, ctx)` run any surface (`core/surfaces/*`) through the pipeline.
  `/v1/completions` now uses them: its requests are logged and counted with
  `surface: "completions"` / `"completions_stream"` instead of `chat` /
  `chat_stream` (MCP tools still apply to non-streaming completions).

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

- **One request pipeline with a single finalize** (2.3, `src/core/pipeline.ts`).
  Non-stream chat, embeddings, images and (via `begin`/`finalize`) streams run
  after/on-error plugins, one request-log line and the metrics exactly once.
  The request log now reaches the SQLite store, so `GET /admin/logs` and the
  dashboard show traffic (round-2). `/metrics` now has tokens, cost (targets
  with `costPer1k*Tokens`), provider errors (every failed upstream attempt,
  including ones that failed over), circuit-breaker state, MCP server up and
  rate-limit rejections (B3-6). A plugin short-circuit response without
  `usage` answers 200 instead of 500.
- **MCP agentic loop** (2.7, `src/core/mcp-loop.ts`): every round goes through
  the executor; the response `usage` sums every upstream call (was the last
  round only); exceeding `maxCallDepth` answers `502 mcp_depth_exceeded` with
  a meaningful message and is request-logged (was a bare 500).
- **Embeddings / images** (2.4): `encoding_format` (`float` | `base64`; a base64
  embedding is passed through as a string) and images `quality` / `style`
  reach the upstream (were dropped); a client disconnect now aborts the
  upstream call (was only the request timeout).

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
