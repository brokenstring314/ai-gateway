# Runtime-config Admin API (0.3.0)

Channels (upstream targets) and their keys, published models and their bindings, routing settings, config
versions with rollback, the audit log and provider presets — all JSON under `/admin`, changed live without a
restart. Client keys with token quota / RPM / TPM and usage statistics: [Key limits and usage](#key-limits-and-usage). 中文说明见 [README_CN.md](../README_CN.md#运行时配置管理-api030)。

## Rules for every endpoint

- **Auth.** Same credentials as the rest of the admin API: `adminSecret` (`X-Admin-Secret` or Bearer), a key-store
  key with `admin` or `read_only` scope, or a bootstrap key while allowed — or a console session cookie
  ([Console sessions](#console-sessions)). `read_only` may call every `GET`; every
  write (`POST` / `PATCH` / `PUT` / `DELETE`) needs `admin`. The audit log records who acted as `key:<id>`,
  `admin-secret` or `bootstrap-key` — never the credential.
- **CSRF.** Credentials travel only in headers, which a browser never adds by itself. In addition every write is
  refused when it comes from another site (`Sec-Fetch-Site: cross-site`, or an `Origin` that is neither this
  server nor in `cors.origins`: `403 csrf_rejected`) or carries a non-JSON body (`415 unsupported_media_type`).
  Requests authenticated by the console's session cookie additionally need the double-submit CSRF token
  (`X-CSRF-Token`, see [Console sessions](#console-sessions)).
- **Strict bodies.** Unknown fields, wrong types and out-of-range values are `400 invalid_request` with the field.
- **Optimistic concurrency.** Every resource has a `revision` (also its `ETag`). Writes to an existing resource need
  `If-Match: "<revision>"` (`W/"7"` and `7` are accepted): missing → `428 precondition_required`; stale →
  `409 revision_mismatch` with `currentRevision`. A revision is the config version that last changed the
  resource, so it only grows — after a rollback too.
- **All or nothing.** One SQLite transaction per write: resource rows → config version (full snapshot, key
  ciphertext only) → audit row → the new runtime is built with the same validation as startup and swapped in →
  commit. If the result is invalid (unknown target in the strategy, alias to a missing model, a model promising
  more than its upstream, …) nothing is written: `422 config_invalid` with the reason, the running config keeps
  serving. Requests in flight finish on the config they started with.
- **Backups.** Before each write the database is copied with `VACUUM INTO` to
  `config.sqlite.backup-<time>.bak` next to it; the newest 5 are kept. `CONFIG_BACKUP_MIN_INTERVAL_MS` (default 0:
  every write) spaces them out on busy installs.
- **Never a key.** Upstream keys are returned only as a hint (`sk-…abcd`), in responses, versions, audit entries
  and logs. Base URLs are shown with query credentials scrubbed.
- **Read-only file mode.** With `runtimeConfig.source: file` the `GET`s show the file's config (`"readOnly": true`)
  and every write answers `403 config_read_only`.
- Write responses carry the resource, `configVersion`, `ETag` and `X-Config-Version`.

## Channels

| Method | Path | Body / notes |
| ------ | ---- | ------------ |
| GET | `/admin/channels` | `{ object, source, readOnly, data: [channel] }` |
| GET | `/admin/channels/:id` | one channel + `ETag` |
| POST | `/admin/channels` | create (no If-Match) → 201 |
| PATCH | `/admin/channels/:id` | any of the create fields except `keys` |
| DELETE | `/admin/channels/:id` | `409 channel_in_use` while a model binds it |
| POST | `/admin/channels/:id/keys` | `{ "keys": [{ "key", "weight"?, "enabled"? }] }` → 201 |
| PATCH | `/admin/channels/:id/keys/:keyId` | `{ "enabled"?, "weight"? }` |
| POST | `/admin/channels/:id/keys/:keyId/enable` · `/disable` | enabling clears an automatic `invalid` / `quota` status |
| DELETE | `/admin/channels/:id/keys/:keyId` | |
| POST | `/admin/channels/:id/test` | `{ "model"?, "keyId"? }`: without `model` calls `GET /models`, with it a 1-token chat; `{ ok, status, latencyMs, error? }` |
| POST | `/admin/channels/:id/fetch-models` | `{ "keyId"? }` → `{ models: [ids] }` from the upstream `GET /models` |
| GET | `/admin/channels/:id/balance` | upstream account balance (read_only; see below) |

**Balance (informational).** `GET /admin/channels/:id/balance` asks the provider for the account balance with the
channel's first enabled key, so the owner knows when to top up. Supported presets: `deepseek`
(`GET https://api.deepseek.com/user/balance` → `{ available, balances: [{ currency, total }] }` from `is_available` /
`balance_infos[].total_balance`) and `openrouter` (`GET …/api/v1/credits` → remaining `total_credits − total_usage`
in USD). Other presets answer `{ "supported": false }` without an upstream call (the console shows “—”). Same SSRF
guard, 10 s timeout and no redirects as the probes, 64 KiB response cap, 30 lookups per minute per caller and 60
overall; upstream errors come back as `{ ok: false, error }` with the key scrubbed. Nothing is stored, logged as a
price or used for any cost computation — the gateway has none.

Key operations use the **channel's** If-Match and bump its revision. Test and fetch-models need `admin`, are limited
to 10 calls per minute per caller and 30 overall (`429` + `Retry-After`), time out after 10 s, read at most 2 MiB
and never follow redirects.

Create body:

```json
{
  "name": "deepseek-main",            // letters, digits . _ : @ / -
  "preset": "deepseek",               // GET /admin/presets
  "baseURL": "https://api.deepseek.com/v1",   // optional when the preset has a public default
  "enabled": true,
  "priority": 0,                      // list order of channels (global strategy default order)
  "models": ["deepseek-v4-flash"],    // what the channel serves when models are derived (no models: section)
  "keyStrategy": "round_robin",       // round_robin | weighted | fill_first
  "keyCooldownSeconds": 30,           // after a 429 without Retry-After
  "settings": { "weight": 1, "retry": {…}, "circuitBreaker": {…}, "concurrency": {…} },
  "keys": [{ "key": "sk-…", "weight": 1, "enabled": true }]
}
```

Channel view: the fields above plus `id`, `effectiveBaseURL`, `urlPolicy` (`public` for URLs written here,
`trusted` for channels imported from the config file), `revision`, `createdAt`, `updatedAt` and
`keys: [{ id, kind (encrypted | env_ref), hint, enabled, status (ok | invalid | quota), weight, lastError,
lastErrorAt, cooldownUntil? }]`.

Keys typed here are stored encrypted (needs `GATEWAY_SECRET_KEY`, else `422 secret_key_missing`). `${VAR}`
references are only allowed in the config file: in an API key or base URL they would let an admin send any
environment variable to a server of their choice.

### Base URLs: public internet only (SSRF)

A base URL written through the API (or a preset default it falls back to) must reach the public internet. Refused
with `422 unsafe_base_url`: loopback, private (10/8, 172.16/12, 192.168/16), link-local and cloud metadata
(169.254/16, 169.254.169.254), CGNAT (100.64/10), 0/8, benchmarking/documentation/multicast/reserved ranges, IPv6
`::`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, multicast, documentation, and IPv4 embedded in IPv6
(`::ffff:a.b.c.d`, NAT64, 6to4, Teredo); `localhost`, `*.local`, `*.internal`, `*.home.arpa`, single-label names;
names resolving to any such address (every address must be public) or not resolving; credentials in the URL or
its query (the error carries `fields: [{ "path": "baseURL", … }]` so the console shows it on the field). The check runs again before every upstream call of such a channel (DNS answers cached 30 s), so a name
re-pointed at a private address later (DNS rebinding) is refused at request time, and redirects are never
followed. There is no switch for private networks yet; local model servers (Ollama, vLLM) can still be configured
in the config file, which is trusted. An explicit opt-in for local/LAN services is on the roadmap.

## Models

| Method | Path | Body / notes |
| ------ | ---- | ------------ |
| GET | `/admin/models` | `{ modelSource, data: [model], published: [{ name, enabled, available, channels }] }` |
| GET | `/admin/models/:id` | one model + `ETag` |
| POST | `/admin/models` | create → 201 |
| PATCH | `/admin/models/:id` | `name`, `displayName`, `description`, `enabled`, `metadata`, `strategy`, `balance`, and optionally `bindings` (replaces all bindings): fields and bindings are applied in one transaction — one config version, all or nothing, one `If-Match` (the console's model drawer saves this way) |
| PUT | `/admin/models/:id/bindings` | `{ "bindings": [binding] }` replaces all bindings |
| DELETE | `/admin/models/:id` | `422` while an alias points to it |

```json
{
  "name": "my-chat",
  "strategy": "fallback",          // fallback: priority groups (default) | loadbalance: one group
  "balance": "round_robin",        // within a group: weighted (default) | round_robin | least_inflight
  "metadata": { "maxOutputTokens": 8192 },
  "bindings": [
    { "channel": "deepseek-main", "upstreamModel": "deepseek-v4-flash", "priority": 0, "weight": 2 },
    { "channelId": "ch_…", "priority": 0 },
    { "channel": "backup", "priority": 1, "enabled": true, "params": { "temperature": 0.3 } }
  ]
}
```

A binding names its channel by `channelId` or `channel` (name). Model writes need explicit published models:
while models are derived from the channels' `models` lists they answer `409 models_derived` — switch once with
`PATCH /admin/settings {"modelSource": "explicit"}`, which turns the current derived list into editable models
(same channels, same order; weights under a global loadbalance).

A model whose bindings are all disabled, drained (weight 0) or on disabled channels stays published: requests
(and its aliases) get `503 model_unavailable`, `/v1/models` lists it with `"available": false`.

## Console sessions

The admin console (`/admin/dashboard`) never keeps the admin key in the browser. It exchanges it once for a
server-side session:

| Method | Path | Notes |
| ------ | ---- | ----- |
| POST | `/admin/session/login` | public. `{ "key": "<admin or read_only key, or adminSecret>" }` → `{ actor, scopes, sessionId, csrfToken, expiresAt, idleTimeoutSeconds }` and two cookies; `401 invalid_credentials`, `403 insufficient_scope` (inference key), `429 login_locked` + `Retry-After` |
| POST | `/admin/session/logout` | ends the cookie's session (needs `X-CSRF-Token` when the session is live) → 204, cookies cleared |
| GET | `/admin/session` | who is calling: `{ via: "session" \| "header", actor, scopes, csrfToken?, expiresAt? }` |
| GET | `/admin/sessions` | live sessions `{ id, actor, scopes, createdAt, lastSeenAt, expiresAt, idleExpiresAt, ip, userAgent, current }` |
| DELETE | `/admin/sessions/:id` | revoke (admin scope, or your own session) → 204 / 404 |

- **Cookies.** `aigw_session` (opaque random id; `HttpOnly; SameSite=Strict; Path=/admin`) and `aigw_csrf` (random
  token readable by the page; `SameSite=Strict; Path=/admin`). Both get `Secure` when the request is https or carries
  `X-Forwarded-Proto: https` (`console.secureCookie: auto | always | never`).
- **CSRF.** Every non-GET request authenticated by the cookie must send `X-CSRF-Token` equal to both the `aigw_csrf`
  cookie and the token stored in the session (constant-time compare), else `403 csrf_token_invalid`. The Origin /
  `Sec-Fetch-Site` / JSON-only guard above applies as well.
- **Lifetime.** 12 h absolute, 60 min idle (`console.sessionTtlMinutes`, `console.idleTimeoutMinutes`); expired or
  unknown cookies get `401 session_expired` and are cleared. Sessions live in process memory only (a restart signs
  everyone out; at most 64, least recently used evicted) — no database read anywhere, and `/v1/*` never looks at
  cookies.
- **Credential follows.** A session from a key-store key is re-checked on every admin request: revoked, expired or
  without `admin` / `read_only` → ended. Bootstrap-key sessions end once bootstrap keys are retired. The audit log
  records `console_login`, `console_logout`, `console_session_revoked` and `console_login_failed` (client IP, never the
  key), with the session's actor (`key:<id>`, `admin-secret`, `bootstrap-key`) on every write.
- **Lockout.** `console.maxLoginFailures` (5) failures from one client IP lock it out for `console.lockoutMinutes`
  (15); at most 60 failures per minute overall. Behind a reverse proxy set `TRUSTED_PROXIES`, or every client shares
  the proxy's address. Header (Bearer / `X-Admin-Secret`) access is not affected and always wins over a cookie.

### Playground

`POST /admin/playground/chat/completions` (admin scope; with a session it needs the CSRF token) takes an OpenAI chat
completions body and runs it through the real gateway routing — published-model check, bindings, metadata policy,
failover, streaming — exactly like `/v1/chat/completions`, but authorized by the admin credential instead of a
client key. Usage is recorded under the key id `console-playground` (no limits).

## Settings

`GET /admin/settings` → `{ strategy, aliases, plugins, compatibility, modelSource, revision }`.
`PATCH /admin/settings` (If-Match = settings revision) with any of them; each given field replaces the stored
one (`aliases: {}` / `plugins: []` / `compatibility: null` clear it). Same schemas as the config file.

## Versions, rollback, audit, presets

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/admin/config/versions?limit=&before=` | `{ head, data: [{ version, createdAt, actor, summary }] }`, `ETag` = head |
| GET | `/admin/config/versions/:v` | one version with its snapshot (no key ciphertext) |
| POST | `/admin/config/versions/:v/rollback` | If-Match = current head version; restores every runtime row of `v` as a new version |
| GET | `/admin/audit?limit=&before=` | newest first: `{ id, at, actor, action, resourceType, resourceId, detail }` |
| GET | `/admin/presets` | provider presets: `baseURL`, `baseURLRequired`, `adminUsable`, known models with metadata |

## Load balancing and keys at a glance

- **Channels of a model:** bindings are grouped by `priority` (lower first). The first group serves; the next group
  is used only when every channel of the group is unavailable or failed. Inside a group `balance` picks the order
  (`weighted` random by weight, `round_robin`, `least_inflight` = fewest requests in flight per unit of weight).
  Weight 0 drains a binding. Legacy shapes: `strategy: fallback` without priorities = one channel per group
  (ordered fallback, as before); `strategy: loadbalance` = one group by weight.
- **Keys of a channel:** `keyStrategy` `round_robin` (default), `weighted`, `fill_first` (first usable key until it
  is out). Upstream `429`: that key cools down for `Retry-After` (capped at 1 h) or `keyCooldownSeconds` and the
  same request is retried at once with the next key. `401`: the key is disabled (`invalid`, last error recorded,
  audit entry `key_auto_disabled`, persisted asynchronously) and the next key is tried. `402`: the key cools down
  like a `429` (`Retry-After` capped at 1 h, else `keyCooldownSeconds`), but softly — the channel still uses it
  when no other key is usable, so one `402` never takes a channel down — and the next key is tried; the key is
  disabled (`quota`, audited and persisted as above) only after 3 consecutive account-level `402`s on it within
  an hour with no successful call in between. A `402` that names the request (OpenRouter's "requires more credits,
  or fewer max_tokens", credit held by in-flight requests) never counts toward that. A `402` is not a breaker
  failure; it fails over to the next channel like a key error, and when no channel is left the client gets the
  `402`. Only when no key is left does the channel count as failed and the request fail over to the next channel. A channel
  whose keys all cool down answers `429` with the remaining `Retry-After` (no upstream call); one whose keys are
  all disabled answers `503 no_upstream_key` until an operator re-enables or adds a key.
- None of this reads the database on the request path: routing, key choice and key health are in memory.

## Key limits and usage

The gateway has one owner. There are no prices, costs, money quotas, payments or user accounts (0.3.0 removed the
`budget` plugin and every price field). Client keys handed to other people are limited in tokens and requests.

### Keys

| Method | Path | Scope | Body / notes |
| ------ | ---- | ----- | ------------ |
| GET | `/admin/keys`, `/admin/keys/:id` | read_only | key views (below); `:id` sends `ETag` = the key's `revision` |
| POST | `/admin/keys` | admin | `{ name, scopes?, expiresAt?, allowedModels?, quotaTokens?, rpm?, tpm? }` → 201, the secret once |
| PATCH | `/admin/keys/:id` | admin | any of `name`, `scopes`, `allowedModels`, `expiresAt`, `quotaTokens`, `rpm`, `tpm` (`null` clears); `If-Match` required. `allowedModels`: omitted = unchanged, `null` = every model, `[]` = no model at all (the key can call nothing), a list = those models |
| POST | `/admin/keys/:id/reset-usage` | admin | used tokens → 0, `usageResetAt` = now; `If-Match` optional (checked when sent) |
| PUT, DELETE, `…/revoke`, `…/rotate` | | admin | unchanged (PUT: name and scopes only, no If-Match) |

`PATCH` follows the same rules as the runtime-config writes: strict body (`400` for unknown fields, a
non-integer, `rpm`/`tpm` < 1, `quotaTokens` < 0), CSRF guard, `If-Match: "<revision>"` (missing → `428
precondition_required`, stale → `409 revision_mismatch` with `currentRevision`). Every key write (create, update,
patch, revoke, rotate, delete, reset-usage) is recorded in `GET /admin/audit` (`resourceType: "api_key"`,
actions `key_create`, `key_update`, `key_delete`, `key_revoke`, `key_rotate`, `key_reset_usage`; the detail holds
changed field names and limits, never a key) when the server runs with the config store. Key settings are not
part of config versions and are not rolled back.

Key view (added in 0.3.0 P5):

```json
{
  "id": "…", "name": "friend", "scopes": ["inference"], "allowedModels": ["ds-chat"], "expiresAt": null,
  "quotaTokens": 2000000,      // null = unlimited
  "rpm": 20,                   // null = the rate-limit plugin's maxRequestsPerMinute (if any)
  "tpm": null,                 // null = the rate-limit plugin's maxTokensPerMinute (if any)
  "usedTokens": 1834121,       // live counter of the running server
  "remainingTokens": 165879,   // null without a quota
  "quotaExhausted": false,
  "usageResetAt": null,
  "revision": 4
}
```

### What counts, and when a key is refused

- **Tokens** = prompt + completion tokens of a finished request as the upstream reports them (cache-hit and
  reasoning tokens are part of those). For streams the gateway always asks the upstream for a usage chunk
  (`stream_options.include_usage`, on every provider that supports it) and keeps that chunk off a client stream
  that did not ask for it. Only when the upstream sends no usage (a provider without `stream_options`, a stream the
  client abandoned) are tokens estimated: CJK characters count one token each, other text UTF-8 bytes / 4. MCP tool rounds are summed. Refused requests count 0.
- **Quota:** checked once, before the request starts: used ≥ quota → `403 quota_exhausted` (type
  `insufficient_quota`, no `Retry-After`: the quota never refills by itself). An admitted request always runs to
  the end — streams are never cut for quota — and its tokens are added when it ends, so the last request and
  requests already in flight can take the key past its quota. Raise the quota or reset the usage to re-open it.
- **Not meterable:** image generation and pass-through proxy routes have no token usage, so a key **with a
  quota** gets `403 quota_not_metered` there (keys without a quota are unaffected).
- **RPM / TPM:** fixed one-minute windows per key. RPM counts admitted requests; TPM refuses new requests once
  the tokens of requests completed in the window reach it. Both answer `429 rate_limit_exceeded` with
  `Retry-After`. A key with its own `rpm` is exempt from the rate-limit plugin's per-minute limit (its daily limit
  still applies); a key without one is limited by the plugin. A key without its own `tpm` uses the plugin's
  `maxTokensPerMinute` when set. Config-file keys (`auth.keys`) have no own limits.
- **Order:** published model and `allowedModels` (403/404) → quota → RPM → TPM → plugins.
- **Hot path:** all of this reads in-memory counters only (no database access). Used tokens are persisted
  asynchronously about once a second (`USAGE_FLUSH_INTERVAL_MS`) and on shutdown, restored at startup, and never
  reset by a config change or rollback. A crash loses at most the last interval of counted tokens. Counters are
  per process (replicas do not share them).

### `GET /admin/usage`

Any `read_only` credential. Query:

| Param | Default | Notes |
| ----- | ------- | ----- |
| `groupBy` | `key` | `key` \| `model` (published name, aliases resolved) \| `channel` (`none` = no upstream call) |
| `from`, `to` | the last 7 days up to today | `YYYY-MM-DD`, inclusive, at most 366 days |
| `tz` | `UTC` | IANA zone (`Asia/Shanghai`): `from` / `to` / `daily` dates are calendar days there |
| `daily` | `false` | `true`: every group also gets a `daily` array |

```json
{
  "object": "usage", "groupBy": "key", "from": "2026-11-01", "to": "2026-11-02", "tz": "Asia/Shanghai",
  "data": [
    { "key": "3f2a…", "name": "friend", "kind": "store",   // store | config (auth.keys entry n: cfg_<n>) | deleted | none (no key)
      "requests": 12, "errors": 1, "inputTokens": 900, "outputTokens": 4200, "totalTokens": 5100,
      "cacheHitTokens": 640, "reasoningTokens": 1300, "estimatedRequests": 0,
      "avgLatencyMs": 2310, "maxLatencyMs": 8120 }
  ],
  "totals": { "requests": 12, "errors": 1, … }
}
```

Storage: every finished request — refused ones included, as errors — is added in memory to an hourly bucket
(UTC hour × key × model × channel) and written to `<data dir>/usage.sqlite` (WAL) in batches about once a second;
the endpoint flushes first, so it always includes every finished request. Buckets are whole UTC hours: a day in a
zone with a :30 / :45 offset is accurate to the hour. Rollups are kept indefinitely (they grow with hours ×
distinct key/model/channel, not with traffic). Per-request rows stay in `GET /admin/logs` (now with `keyId`,
`cacheHitTokens`, `reasoningTokens`, `durationMs`, `status`). Without a data directory (embedded `createApp`)
the endpoint answers `503 usage_unavailable`.
