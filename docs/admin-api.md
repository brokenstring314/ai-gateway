# Runtime-config Admin API (0.3.0)

Channels (upstream targets) and their keys, published models and their bindings, routing settings, config
versions with rollback, the audit log and provider presets — all JSON under `/admin`, changed live without a
restart. 中文说明见 [README_CN.md](../README_CN.md#运行时配置管理-api030)。

## Rules for every endpoint

- **Auth.** Same credentials as the rest of the admin API: `adminSecret` (`X-Admin-Secret` or Bearer), a key-store
  key with `admin` or `read_only` scope, or a bootstrap key while allowed. `read_only` may call every `GET`; every
  write (`POST` / `PATCH` / `PUT` / `DELETE`) needs `admin`. The audit log records who acted as `key:<id>`,
  `admin-secret` or `bootstrap-key` — never the credential.
- **CSRF.** Credentials travel only in headers, which a browser never adds by itself. In addition every write is
  refused when it comes from another site (`Sec-Fetch-Site: cross-site`, or an `Origin` that is neither this
  server nor in `cors.origins`: `403 csrf_rejected`) or carries a non-JSON body (`415 unsupported_media_type`).
  The console's cookie session (P6) adds a double-submit token on top.
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
  "settings": { "weight": 1, "retry": {…}, "circuitBreaker": {…}, "concurrency": {…},
                "costPer1kInputTokens": 0, "costPer1kOutputTokens": 0 },
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
its query. The check runs again before every upstream call of such a channel (DNS answers cached 30 s), so a name
re-pointed at a private address later (DNS rebinding) is refused at request time, and redirects are never
followed. There is no switch for private networks yet; local model servers (Ollama, vLLM) can still be configured
in the config file, which is trusted. An explicit opt-in for local/LAN services is on the roadmap.

## Models

| Method | Path | Body / notes |
| ------ | ---- | ------------ |
| GET | `/admin/models` | `{ modelSource, data: [model], published: [{ name, enabled, available, channels }] }` |
| GET | `/admin/models/:id` | one model + `ETag` |
| POST | `/admin/models` | create → 201 |
| PATCH | `/admin/models/:id` | `name`, `displayName`, `description`, `enabled`, `metadata`, `strategy`, `balance` |
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
  same request is retried at once with the next key. `401` / `402`: the key is disabled (`invalid` / `quota`,
  last error recorded, audit entry `key_auto_disabled`, persisted asynchronously) and the next key is tried. Only
  when no key is left does the channel count as failed and the request fail over to the next channel. A channel
  whose keys all cool down answers `429` with the remaining `Retry-After` (no upstream call); one whose keys are
  all disabled answers `503 no_upstream_key` until an operator re-enables or adds a key.
- None of this reads the database on the request path: routing, key choice and key health are in memory.
