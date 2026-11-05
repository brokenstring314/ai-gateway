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
- **Failed header credentials lock the client out** (since 0.3.0, red team 2026-11-05 P4). A `401` for a presented
  `X-Admin-Secret` or `Authorization: Bearer` counts as a failure of the client IP in the same counter as the console
  sign-in ([Console sessions](#console-sessions) → Lockout): `console.maxLoginFailures` (5) failures within
  `console.lockoutMinutes` (15) lock that IP out, and every header credential from it — valid or not — then gets
  `429 auth_locked` + `Retry-After` until the lockout ends (checking it would answer the guess). A success does
  **not** clear the IP's failures, so a `read_only` key holder cannot interleave valid requests to keep guessing
  `adminSecret`. Requests without credential headers and valid keys lacking the scope (`403`) are not counted. Many
  failures overall only slow attempts down (≤ 2 s), never refuse them. The lockout is audited once
  (`admin_auth_locked`, client IP). Other IPs are unaffected.
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
| PATCH | `/admin/channels/:id` | any of the create fields except `keys`, plus `apiKeys` (replaces **every** stored key); a change of origin needs `apiKeys` ([below](#changing-a-channels-origin-needs-its-keys-again)) |
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
  "keyCooldownSeconds": 30,           // longest key cooldown after an upstream 429 / 402 (Retry-After honoured up to this)
  "settings": { "weight": 1, "retry": {…}, "circuitBreaker": {…}, "concurrency": {…} },
  "keys": [{ "key": "sk-…", "weight": 1, "enabled": true }]
}
```

`settings.circuitBreaker` takes `failureThreshold`, `successThreshold`, `maxHalfThreshold`, `timeoutMs` and
`countTimeouts` (default `false`): whether the gateway's own `requestTimeout` firing before any output counts as a
breaker failure. Off by default because the caller decides how long a request runs (`max_tokens`, prompt size), so
a few deliberately slow requests from one key must not open the circuit for everyone (review 2026-11-05 D4).

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
re-pointed at a private address later is refused at request time, and redirects are never followed. The
connection is **pinned** to the checked address (red team RA3 / K5): the name is resolved once, every address
must be public, and the request goes to that IP (IPv4 first; on a refused connection the next checked address)
with the original `Host` header, TLS SNI and certificate check against the original name — the HTTP stack never
resolves the name a second time, so a rebinding DNS server cannot answer "public" to the check and "internal" to
the connection. This covers chat / completions / embeddings (streamed or not), `test`, `fetch-models`, `balance`
and the pass-through proxy. Note: with `HTTPS_PROXY` / `HTTP_PROXY` set, the proxy is asked for the IP, and a
`NO_PROXY` entry naming the host no longer matches these requests. There is no switch for private networks yet; local model servers (Ollama, vLLM) can still be configured
in the config file, which is trusted. An explicit opt-in for local/LAN services is on the roadmap.

### Changing a channel's origin needs its keys again

Stored keys are only ever sent to the origin they were entered for. A `PATCH /admin/channels/:id` that moves a
channel **with stored keys** to another origin — scheme, host or port of the effective base URL, also through a
new `preset` or `baseURL: null` falling back to the preset default — must carry the keys for the new address in
the same request:

```json
{ "baseURL": "https://openrouter.ai/api/v1", "apiKeys": [{ "key": "sk-or-…" }] }
```

- Without `apiKeys` → `400 api_keys_required_on_base_url_change` (`fields: [{ "path": "apiKeys", … }]`), nothing
  is written. A path-only change on the same origin needs nothing.
- `apiKeys` (`[{ key, weight?, enabled? }]`, at most 100) **replaces every stored key** of the channel, encrypted
  ones and `${VAR}` references alike, in the same transaction (one config version). It may also be sent without an
  origin change to replace all keys at once.
- `test`, `fetch-models` and `balance` only ever use the saved base URL and keys. The audit entry of the write
  records `originChange` (old → new origin) and `keysReplaced` (hints only).
- The console's channel drawer shows a notice and a required key field as soon as the base URL moves to another
  origin.

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
- **Credential follows.** A session from a key-store key is re-checked on every admin request: revoked, **rotated**
  (since 0.3.0, red team RA4; also a rotation by the CLI on the same database), expired or without `admin` /
  `read_only` → ended. `POST /admin/keys/:id/rotate` and `…/revoke` end that key's sessions at once (audit detail
  `sessionsEnded`), including the caller's own session when it was signed in with that key. Bootstrap-key sessions
  end once bootstrap keys are retired. `adminSecret` is a startup setting: changing it needs a restart, which ends
  every session (they live in memory only). The audit log
  records `console_login`, `console_logout`, `console_session_revoked` and `console_login_failed` (client IP, never the
  key), with the session's actor (`key:<id>`, `admin-secret`, `bootstrap-key`) on every write.
- **Lockout.** `console.maxLoginFailures` (5) failures from one client IP lock it out for `console.lockoutMinutes`
  (15). There is no global lockout: while 60 or more sign-ins fail per minute across all IPs, every sign-in attempt
  is only slowed down (500 ms per multiple of 60, at most 2 s) before its key is checked, so a flood of bad attempts
  can never lock the real admin out of an IP that is not locked (red team RA1; was a hard `429` for everyone).
  The client IP is the TCP peer; `X-Forwarded-For` / `X-Real-IP` count only from a proxy listed in `TRUSTED_PROXIES`
  (default: none — loopback is no longer trusted, RA2), read right to left skipping trusted proxies. Behind a reverse
  proxy (also one on the same host) set `TRUSTED_PROXIES`, or every client shares the proxy's address; the gateway
  logs one warning when a request from loopback carries those headers while nothing is trusted. Header (Bearer /
  `X-Admin-Secret`) credentials always win over a cookie and share this per-IP counter (since 0.3.0, P4): failed
  header credentials count toward the lockout, and a locked IP gets `429 auth_locked` for header credentials as it
  gets `429 login_locked` at sign-in ([Rules for every endpoint](#rules-for-every-endpoint)).

### Playground

`POST /admin/playground/chat/completions` (admin scope; with a session it needs the CSRF token) takes an OpenAI chat
completions body and runs it through the real gateway routing — published-model check, bindings, metadata policy,
failover, streaming — exactly like `/v1/chat/completions`, but authorized by the admin credential instead of a
client key. Usage is recorded under the key id `console-playground` (no limits).

## Settings

`GET /admin/settings` → `{ strategy, aliases, plugins, compatibility, modelSource, limits, revision }`.
`PATCH /admin/settings` (If-Match = settings revision) with any of them; each given field replaces the stored
one (`aliases: {}` / `plugins: []` / `compatibility: null` / `limits: null` clear it). Same schemas as the config
file.

**`limits.maxOutputTokens`** (integer 1 – 100,000,000, default **65536**; `limits: {}` or `null` = the default): the
largest `max_tokens` / `max_completion_tokens` a request may ask for on a published model whose metadata has no
`maxOutputTokens` (derived models, models without metadata). A larger value is refused with
`400 max_tokens_exceeded` (`param` = the field the client sent), never clamped. A model's own
`metadata.maxOutputTokens` always wins. The same cap is the output part of a key's quota reservation when a
request sends no `max_tokens` ([below](#what-counts-and-when-a-key-is-refused)). In the config file it is the
top-level `limits:` section (database mode: imported once, then this endpoint; console: 设置 → 请求上限).

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
  is out). Upstream `429`: that key cools down for the upstream's `Retry-After`, but **never longer than the
  channel's `keyCooldownSeconds`** (default 30, max 3600; without `Retry-After` exactly that), and the same
  request is retried at once with the next key. The cooldown is **soft**: a channel whose other keys are all
  unusable still sends requests to a cooling key instead of answering everyone `429` / `503 no_upstream_key`, so
  one client's 429 never takes a shared key or channel down; a success on the key ends its cooldown. A `429` is
  not a circuit-breaker failure (the request still fails over to the next channel when the channel has nothing
  left). `401`: the key is disabled (`invalid`, last error recorded,
  audit entry `key_auto_disabled`, persisted asynchronously) and the next key is tried. `402`: the key cools down
  like a `429` (`Retry-After` capped at `keyCooldownSeconds`), but softly — the channel still uses it
  when no other key is usable, so one `402` never takes a channel down — and the next key is tried; the key is
  disabled (`quota`, audited and persisted as above) only after 3 consecutive account-level `402`s on it within
  an hour with no successful call in between. A `402` that names the request (OpenRouter's "requires more credits,
  or fewer max_tokens", credit held by in-flight requests) never counts toward that. A `402` is not a breaker
  failure; it fails over to the next channel like a key error, and when no channel is left the client gets the
  `402`. Only when no key is left does the channel count as failed and the request fail over to the next channel. A channel
  whose keys are all disabled answers `503 no_upstream_key` until an operator re-enables or adds a key.
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
| PUT, DELETE, `…/revoke`, `…/rotate` | | admin | unchanged (PUT: name and scopes only, no If-Match); revoke / rotate end the key's console sessions |

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
  (`stream_options.include_usage`, on every provider that supports it) and keeps usage off a client stream that
  did not ask for it. When the upstream sends no usage, or an implausible one (missing, all zero, negative / not a
  number, zero completion tokens although there is output) — non-streaming responses included, per upstream call
  and per MCP round — tokens are estimated: CJK characters count one token each, other text UTF-8 bytes / 4, plus
  tools, tool calls and reasoning; the request log marks such a request `usageEstimated`. MCP tool rounds are
  summed — also when the loop fails later (`mcp_depth_exceeded`, a later round's upstream error): the rounds that
  were served still count. Refused requests count 0.
- **Calls cut off by an abort** (review 2026-11-05 F2 / D4): a request that was already sent upstream (past the
  breaker and the concurrency queue) and then ended by the client going away or by the gateway's `requestTimeout`
  (504 `gateway_timeout`) before any answer is not free: it counts the **estimated prompt**, plus, for a
  non-streaming call, **10 output tokens per second** it ran (a deliberately slow rate, never more than the
  request's output cap); a stream cut before its first chunk counts the prompt only. Marked `usageEstimated`. A
  request aborted while still queued for a slot never reached the upstream and counts 0. Streams cut after output
  count what was streamed (see the client-stall rule below).
- **Quota:** checked before the request starts: used ≥ quota → `403 quota_exhausted` (type `insufficient_quota`, no
  `Retry-After`: the quota never refills by itself). An admitted request always runs to the end — streams are never
  cut for quota — and its tokens are added when it ends. Raise the quota or reset the usage to re-open it.
- **In-flight reservations.** An admitted request of a key with a quota or a TPM **reserves** its estimated prompt
  plus its output cap (the larger of `max_completion_tokens` / `max_tokens`, else the model's `maxOutputTokens`, else
  `limits.maxOutputTokens`; × `n`; embeddings: the input only) until it settles. A new request is admitted only while
  used + reserved < quota; otherwise **`429 quota_in_flight`** with `Retry-After: 1` (type `rate_limit_error`): the
  requests in flight may use the rest, retry when they have finished. Concurrent requests can therefore no longer all
  pass the check before any is counted — the overshoot is bounded by about one request. The reservation is released
  exactly once when the request settles (success, error, client cancel, failover, rejection) and the actual tokens are
  counted instead. Safety net: a reservation that is never settled expires after the request-lifetime bound —
  max(`requestTimeout`, `server.streamMaxDurationSeconds`) + 60 s, or max(**1 h**, `requestTimeout` + 60 s) when
  streams are unbounded — and is
  released lazily on the key's next request. `reset-usage` keeps the reservations of requests in flight.
- **Not meterable:** image generation and pass-through proxy routes have no token usage, so a key **with a
  quota** gets `403 quota_not_metered` there (keys without a quota are unaffected).
- **RPM / TPM:** fixed one-minute windows per key. RPM counts admitted requests; TPM refuses new requests once
  the tokens of requests completed in the window reach it, and also while those tokens plus the reservations of
  requests in flight reach it (`Retry-After: 1`). Both answer `429 rate_limit_exceeded` with `Retry-After`. A key with its own `rpm` is exempt from the rate-limit plugin's per-minute limit (its daily limit
  still applies); a key without one is limited by the plugin. A key without its own `tpm` uses the plugin's
  `maxTokensPerMinute` when set. Config-file keys (`auth.keys`) have no own limits.
- **Order:** published model and `allowedModels` (403/404) → quota (403 `quota_exhausted`, 429 `quota_in_flight`)
  → RPM → TPM → plugins → model metadata / `limits.maxOutputTokens` (400 `max_tokens_exceeded`; the reservation is
  released).
- **Output cap with both fields** (review 2026-11-05 F1): upstreams honour `max_tokens` or `max_completion_tokens`
  (DeepSeek and most OpenAI-compatible servers the former), and both are forwarded, so the effective cap is the
  larger of the two. Different values are refused (`400 conflicting_max_tokens`) rather than guessing which one the
  upstream reads; the same value in both is accepted. Pass-through bodies (`/v1/responses` …) use the largest of
  `max_output_tokens` / `max_completion_tokens` / `max_tokens`, and a max-token plugin cap lowers every field present.
- **A streaming client that stops reading** (review 2026-11-05 D6): once a chunk has waited for the client longer
  than `server.streamIdleTimeoutSeconds` (default 120 s; `0` turns this and the upstream idle timeout off) the stream
  is ended — the upstream request is aborted (a client cancel: never a breaker failure), its concurrency slot,
  breaker permit and reservation are released, and the tokens streamed so far are counted. The gateway pulls the
  upstream only as fast as the client socket accepts data, so a stalled stream holds at most what the kernel socket
  buffers took, plus up to 1 Mi characters of answer text kept for after-request plugins and the usage estimate
  (longer answers are counted, not kept). A client that keeps reading is never cut, however long the answer.
- **Hot path:** all of this — reservations and their expiry included — reads in-memory counters only (no database
  access, no timer). Used tokens are persisted
  asynchronously about once a second (`USAGE_FLUSH_INTERVAL_MS`) and on shutdown, restored at startup, and never
  reset by a config change or rollback. A crash loses at most the last interval of counted tokens. Counters are
  per process (replicas do not share them).

### Error codes of the limits

| Status | `code` | When |
| ------ | ------ | ---- |
| 403 | `quota_exhausted` | the key's used tokens reached its quota |
| 429 + `Retry-After: 1` | `quota_in_flight` | used + tokens reserved by the key's requests in flight reach the quota |
| 403 | `quota_not_metered` | a key with a quota on image generation / pass-through routes |
| 429 + `Retry-After` | `rate_limit_exceeded` | the key's RPM / TPM (in-flight reservations count toward TPM) |
| 400 | `max_tokens_exceeded` | `max_tokens` / `max_completion_tokens` above the model's `maxOutputTokens`, else `limits.maxOutputTokens` |
| 400 | `conflicting_max_tokens` (`param` `max_completion_tokens`) | `max_tokens` and `max_completion_tokens` are both set with different values (send one, or the same value in both) |
| 400 | `api_keys_required_on_base_url_change` | Admin API: `PATCH /admin/channels/:id` moves a channel with keys to another origin without `apiKeys` |

Order of the checks: the key's own meter (quota, RPM) runs **before** the model is looked at (red team 2026-11-05
D3), so a key over its quota gets `403 quota_exhausted` even for an unknown model (was `404 model_not_found`), and
unknown, forbidden and malformed model names count toward the key's RPM.

### Request shape errors (red team 2026-11-05)

Every `/v1` surface (chat, completions, embeddings, images, pass-through) checks these before anything else reads
the body; all are `400` in the OpenAI error shape.

| Status | `code` (`param`) | When |
| ------ | ---------------- | ---- |
| 400 | `invalid_model_name` (`model`) | the model name is longer than 256 characters, or contains control / formatting characters (C0, DEL, C1, U+2028 / U+2029, bidi embeddings / overrides / isolates, BOM) (D3) |
| 400 | `json_too_deep` | the JSON body is nested more than 128 levels deep (was a stack overflow after parsing) (D5) |
| 400 | `duplicate_json_key` | pass-through only: a top-level key appears twice (compared after decoding escapes), so the access check and the routing always read the same `model` (P1) |
| 400 | `max_tokens_exceeded` (the field) | pass-through only: the largest of `max_output_tokens` / `max_completion_tokens` / `max_tokens` (after a max-token plugin lowered it) is above the published model's `maxOutputTokens`, else `limits.maxOutputTokens`; never forwarded or clamped (F4). Bodies without a published model are unaffected |
| 400 | `provider_not_bound` | pass-through: `X-Provider` (a channel name or a provider type) names no enabled channel bound to the body's model; a provider type picks only among the model's own channels, in its routing order (P2) |

Upstream error text (client message, `GET /admin/logs`, stdout) has the channel's upstream keys and key-shaped tokens
replaced by `[key]`; pass-through error bodies up to 1 MiB are scrubbed the same way, larger ones become a generic
error with the same status (P3).

### Admin credential errors

| Status | `code` | When |
| ------ | ------ | ---- |
| 401 | `invalid_admin_secret` / `invalid_api_key` | wrong header credential (counts toward the client IP's lockout); `POST /admin/session/login` answers `invalid_credentials` |
| 429 + `Retry-After` | `auth_locked` | header credential from a client IP locked out after `console.maxLoginFailures` failures (console sign-in and header failures share the counter); `error.retryAfter` in seconds |
| 429 + `Retry-After` | `login_locked` | the same lockout at `POST /admin/session/login` |

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
