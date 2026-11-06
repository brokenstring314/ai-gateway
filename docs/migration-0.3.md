# Upgrading from 0.2.x to 0.3.0

中文版：[migration-0.3.zh.md](migration-0.3.zh.md)

0.3.0 turns the gateway into a live-configured service: channels, upstream keys, published models and routing live
in a SQLite config store, are changed through the Admin API or the new console without a restart, and client keys
get token quotas and RPM / TPM. Several 0.2.x behaviours change on the way. This guide lists what to do; the full
list is in [CHANGELOG.md](../CHANGELOG.md#030---2026-11-05) and the API reference in [admin-api.md](admin-api.md).

## Quick checklist

Do these before (or right after) the first 0.3.0 start:

1. **Back up** your data directory (`GATEWAY_DATA_DIR`, default `./.data`) and config file.
2. **Set `GATEWAY_SECRET_KEY`** if any `targets[].apiKey` is a literal key (not `"${VAR}"`), and always with
   `GATEWAY_ENV=production`: `openssl rand -base64 32`. Store it safely — without it stored keys cannot be decrypted.
3. **Behind a reverse proxy on the same host, set `TRUSTED_PROXIES=127.0.0.1,::1`** (behind a load balancer: its
   range, every proxy in the chain).
4. **Check your model names**: only published models are served. Without a `models:` section every target must
   list the models it serves in `targets[].models`.
5. **Remove** the `budget` plugin and `costPer1k*` fields from the config (validation fails otherwise).
6. **Run `ai-gateway validate -c config.yaml`** with the 0.3.0 binary: removed keys fail with a migration hint.
7. Start the gateway, sign in at `/admin/dashboard` with an `admin` key or `adminSecret`, and check
   `ai-gateway config status -c config.yaml`.

## 1. Config store, first-boot import, file mode

- Runtime resources — `targets` (channels), `strategy`, `aliases`, `plugins`, `compatibility`, `models`, and the new
  `limits` — now live in `<data dir>/config.sqlite`. Startup settings (`server`, `auth`, `adminSecret`, `cors`,
  `observability`, `mcpServers`, `requestTimeout`, `maxRequestBytes`, `passthroughProxy`, `console`) still come
  from the file only and need a restart.
- **First start:** the file's runtime sections are imported once (config version 1). **Later edits to those
  sections in the file are ignored** (a warning is printed). Change them in the console / Admin API, or re-import
  with `ai-gateway config import --force -c config.yaml` and restart.
- **GitOps:** `runtimeConfig: { source: file }` keeps the 0.2.x model — the file is the only source, nothing is
  stored, every Admin API write answers `403 config_read_only`.
- Before each Admin API change the store is copied with `VACUUM INTO` (newest 5 kept); before a schema migration a
  `config.sqlite.pre-migration-*.bak` is written. Files are `0600`.
- The 0.2 whole-config routes (`PUT`/`DELETE /admin/config`, `/admin/config/reload`, history, rollback) still answer
  `410 config_api_removed`; use the resource API (`/admin/channels`, `/admin/models`, `/admin/settings`,
  `/admin/config/versions/:v/rollback`).

## 2. `GATEWAY_SECRET_KEY` (encrypted upstream keys)

- Literal upstream keys are stored AES-256-GCM encrypted under a key derived from `GATEWAY_SECRET_KEY`. Startup
  **refuses** to import or read a literal key without it; `GATEWAY_ENV=production` with the database source always
  requires it. `"${VAR}"` references are stored as references and need no master key.
- Rotation: new key in `GATEWAY_SECRET_KEY`, old one(s) in `GATEWAY_SECRET_KEY_PREVIOUS` (comma-separated).
- Docker: pass it with `-e GATEWAY_SECRET_KEY`.

## 3. Client IP: `TRUSTED_PROXIES` defaults to nobody

- 0.2.x trusted `127.0.0.1,::1` by default and used the leftmost `X-Forwarded-For` hop (client-controlled).
  0.3.0 trusts nobody by default and reads `X-Forwarded-For` right to left, skipping trusted proxies.
- **Action:** nginx / Caddy / a sidecar on the same host → `TRUSTED_PROXIES=127.0.0.1,::1`; load balancer → its
  range. Without it every client shares the proxy's IP for the per-IP rate limit and for the console / admin
  lockout (one warning is logged), so one bad client can lock everyone out.

## 4. Published models only; unknown names → 404

- A model name that is not published is refused with `404 model_not_found` before reaching an upstream — there is
  no fallback to the global strategy any more.
- Without a `models:` section the names in `targets[].models` are published, and a request goes only to targets
  that list its model. **A target without `models` serves nothing.**
- With a `models:` section each public name is bound to targets with a per-binding upstream model name; aliases
  must point at published models.
- Restricted keys (`allowedModels`) get `403 model_not_allowed`; `GET /v1/models` lists only what the calling key may
  use.
- Model names written through the Admin API must be 1–256 characters of `A–Z a–z 0–9 . _ : / @ -`
  (`400 invalid_model_name`); an enabled model needs at least one binding (`400 model_no_bindings`; save drafts with
  `enabled: false`). Requests with a name over 256 characters or with control characters get
  `400 invalid_model_name`. Existing invalid names keep loading with a startup warning.
- A model whose bindings all point at disabled channels answers `503 model_unavailable` (aliases too).
- **Action:** make sure every name your clients send is published; use names from `GET /v1/models`.

## 5. Response `model` is the published name

- Every client response (chat, completions, embeddings, every stream chunk) now carries the **published** name
  instead of the upstream id; `request_logs.model`, the stdout log line and the token metrics' `model` label too.
  The upstream id is in the new `upstreamModel` field / column (`GET /admin/logs?upstreamModel=`).
- Pass-through routes are unchanged: bodies go both ways verbatim, so the upstream's own `model` echo is kept.
- **Action:** clients matching the response `model` against the upstream id, and dashboards filtering logs by
  upstream id, switch to the published name or `upstreamModel`. Old rows are not rewritten.

## 6. Per-key token quota, RPM / TPM, reservations

- Keys get `quotaTokens` (all-time prompt + completion tokens until reset; `null` = unlimited), `rpm`, `tpm`
  (`PATCH /admin/keys/:id`, `ai-gateway keys create --quota-tokens --rpm --tpm`, console 密钥 page).
- Used ≥ quota → `403 quota_exhausted` before the request starts (no auto-refill; raise or reset). Admitted requests
  always finish.
- **Reservations:** an admitted request of a key with a quota or TPM reserves *estimated prompt + output cap* until
  it ends. The output cap is the larger of `max_tokens` / `max_completion_tokens`, else the model's
  `maxOutputTokens`, else `limits.maxOutputTokens` (**default 65536**), × `n`. A new request is admitted only while
  used + reserved < quota, else **`429 quota_in_flight`** (`Retry-After: 1`); TPM counts reservations too.
  Consequence: a key whose remaining quota is below ~65k tokens, calling a model without `maxOutputTokens` and
  without `max_tokens`, is refused with `429 quota_in_flight` / `rate_limit_exceeded` as soon as one request is in
  flight. **Action:** give models a realistic `metadata.maxOutputTokens`, lower `limits.maxOutputTokens`, or have
  clients send `max_tokens`; retry on 429.
- **Since the release after 0.3.0** (final red team 2026-11-06 FQ-1 / FQ-2): images, audio and files count in the
  reservation (≈ 1,600 tokens per image) and so do reasoning budgets (`reasoning.max_tokens`,
  `thinking.budget_tokens` …); one request larger than the quota left → **`400 request_exceeds_quota`**, larger than
  the TPM → **`400 request_exceeds_tpm`**; `n` > 128 → `400 invalid_n`; a request is admitted only while used +
  reserved + its own reservation ≤ quota. A request without `max_tokens` gets the default fitted into the quota left /
  TPM and sent upstream as `max_tokens` (also for unlimited keys when the model has `maxOutputTokens`). **Action:**
  clients near the end of a quota send a smaller `max_tokens`; if an upstream refuses the explicit `max_tokens`, set
  the model's `maxOutputTokens` to the upstream's real limit.
- Missing / implausible upstream `usage` is estimated (CJK-aware), never counted as 0. A call cut off after reaching
  the upstream (client gone, `requestTimeout`) counts its estimated prompt plus 10 output tokens/s (non-stream).
- Keys **with a quota** get `403 quota_not_metered` on image generation and pass-through routes.
- RPM / TPM → `429 rate_limit_exceeded` + `Retry-After`. A key with its own `rpm` is exempt from the rate-limit
  plugin's per-minute value. The plugin's `maxRequestsPerMinute` is no longer required when `maxRequestsPerDay` or
  `maxTokensPerMinute` is set.
- Order of checks: published / allowed model → quota → RPM → TPM → plugins → model limits. The quota check runs
  before the model checks, so an exhausted key asking for an unknown model gets `403 quota_exhausted`, and
  rejected model names count toward RPM.

## 7. `max_tokens` rules

- `max_tokens` and `max_completion_tokens` with **different** values → `400 conflicting_max_tokens`. Send one, or
  the same value in both. The effective cap is the larger one.
- Above the published model's `metadata.maxOutputTokens`, else above `limits.maxOutputTokens` (default **65536**) →
  `400 max_tokens_exceeded` (was forwarded as is). Never clamped.
- Requests over any published model limit (context window, input types, tools, …) → `400` with a specific
  `code` / `param`.
- **Action:** raise `limits.maxOutputTokens` (console 设置 → 请求上限, `PATCH /admin/settings`, or the file's
  `limits:` before first import) or set the model's own `maxOutputTokens`.

## 8. Budget plugin and cost fields removed

- The gateway has no prices or money anywhere. A `budget` plugin entry (even disabled) fails validation;
  `targets[].costPer1kInputTokens` / `costPer1kOutputTokens` are rejected; the Prometheus counter
  `ai_gateway_request_cost_usd` is gone; upstream `usage.cost` / `cost_details` are no longer passed to clients.
- `targets[].priority` / `targets[].budget`, `otlpProtocol: grpc` and unknown keys in built-in plugin configs are
  rejected too (they never had an effect).
- **Action:** delete them; limit client keys with `quotaTokens`. Embedders: `BudgetPlugin`, `costOf`,
  `hasCostRates`, `CostRates` are no longer exported and `buildPluginsFromConfig` takes no `targets`.

## 9. Pass-through proxy: still opt-in, now restricted

- Still off by default (`passthroughProxy.enabled: true`, allow-listed routes only; unlisted → `403
  route_not_allowed`). No breaker, fallback or token accounting on these routes.
- New in 0.3.0: a body repeating a top-level key → `400 duplicate_json_key`; the largest of `max_output_tokens` /
  `max_completion_tokens` / `max_tokens` above the model's limit → `400 max_tokens_exceeded`; `X-Provider: <type>`
  picks only among the channels bound to the body's model (`400 provider_not_bound`); keys with a quota →
  `403 quota_not_metered`; upstream keys echoed in error bodies are replaced by `[key]`.
- **Action:** send each JSON key once and stay within the model's limits.

## 10. Timeouts and the circuit breaker

- The gateway's `requestTimeout` is **no longer a breaker failure** by default (slow requests from one client
  should not open a channel for everyone). `circuitBreaker.countTimeouts: true` restores the old behaviour per
  channel (config file or Admin API channel settings; no console toggle yet). Upstream `429` / `402` are not
  breaker failures either; gateway-internal errors never touch the breaker.
- **Since the release after 0.3.0** (FQ-3): an upstream `403` / `451` refusing the request's *content* (OpenRouter
  "input was flagged", OpenAI safety system, DeepSeek "Content Exists Risk" …) → `400 content_filtered`, no failover,
  not a breaker failure (was `502 upstream_auth_failed` and three flagged prompts opened the channel for everyone).
  Credential / account / region 403s are unchanged.
- Upstream `429` cools the key down softly (at most `keyCooldownSeconds`, default 30 s); `401` disables a key at
  once; `402` disables it only after 3 account-level 402s within an hour.
- New `server.streamIdleTimeoutSeconds` (default 120): a streaming client that stops reading that long is cut off.

## 11. Admin API and console

- **Console:** the 0.2 vanilla-JS console and `/admin/static/*` are gone. `/admin/dashboard` is the new console;
  sign-in exchanges an `admin` / `read_only` key or `adminSecret` for a `HttpOnly` session cookie (12 h, 60 min
  idle, CSRF token on writes). No key is kept in the browser. Configure with the new `console:` block.
- **Header credential lockout:** 5 failed `X-Admin-Secret` / Bearer attempts in 15 min lock that client IP:
  `429 auth_locked` for every header credential, valid ones included; a success does not reset the count.
  **Action:** fix scripts that retry with a wrong secret, and set `TRUSTED_PROXIES` behind a proxy so clients are
  told apart.
- **Writes:** every state-changing `/admin/*` request with a body needs `Content-Type: application/json`; writes
  from a foreign `Origin` are refused (`403 csrf_rejected`); resource writes need `If-Match` (`428` / `409`).
- **Moving a channel to another origin** (scheme, host or port — also via `preset` or `baseURL: null`) must carry
  `apiKeys` for the new address, else `400 api_keys_required_on_base_url_change`; `apiKeys` replaces every stored
  key. Base URLs written through the API must be public internet addresses (`422 unsafe_base_url`); local / LAN
  servers (Ollama, vLLM) can only be configured in the config file for now.
- **Error bodies:** every `/admin/*` error is `{ error: { message, type, code, … } }`; `GET /admin/usage` errors have
  their own codes (`invalid_group_by`, `invalid_timezone`, …). Clients should match on `code`.
- **List shapes:** the 0.2 endpoints keep their envelopes (`/admin/keys` → `{ keys, total }`, `/admin/logs` →
  `{ entries, total }`); 0.3.0 resource lists use `{ object: "list", data }`. See [admin-api.md](admin-api.md#list-responses).

## 12. Other request changes

- JSON nested more than 128 levels → `400 json_too_deep`.
- `developer` messages are sent as `system` to providers without the role, in every compatibility mode.
- Chat content parts `input_audio`, `file` and assistant `refusal` are accepted; explicit `null` optional
  parameters are treated as unset.
- Single-key targets: a target needs `apiKey` or `apiKeys`; under `strategy: fallback` bindings with the same
  `priority` share a group (balanced by weight); `weight: 0` drains a binding in every mode.
- Embedders: when every key of a target is unusable, `gateway.route()` throws `NoUsableKeyError`.

## Every breaking change → action

| CHANGELOG breaking item | What to do |
| --- | --- |
| Responses / logs use the published model name (B3) | Match on the published name; use `upstreamModel` for the upstream id |
| Model names checked, enabled model needs a binding (B7) | Rename invalid models; save binding-less models with `enabled: false` |
| `/admin/usage` error codes (U2) | Match the new specific codes |
| `conflicting_max_tokens` (F1) | Send one of `max_tokens` / `max_completion_tokens`, or equal values |
| Timeouts not counted by the breaker (D4) | Set `circuitBreaker.countTimeouts: true` per channel if you relied on it |
| Request shape limits: `json_too_deep`, `invalid_model_name`, quota before model checks, pass-through `duplicate_json_key` / `max_tokens_exceeded` / `provider_not_bound` | Send each key once, keep `max_*` within limits, use names from `/v1/models` |
| Admin header credential lockout (P4) | Fix scripts retrying wrong secrets; set `TRUSTED_PROXIES` |
| Origin change needs keys (RC1 / RC2) | Send `apiKeys` with a `baseURL` / `preset` change to a new host |
| `limits.maxOutputTokens` default 65536 (RB6) | Raise it or set the model's `maxOutputTokens` |
| `429 quota_in_flight`, TPM counts reservations (RB3) | Retry on 429; set realistic output caps |
| `Retry-After` cooldown capped, 429 not a breaker failure (RB5) | Nothing; tune `keyCooldownSeconds` if needed |
| `TRUSTED_PROXIES` defaults to nobody (RA2) | Same-host proxy: `127.0.0.1,::1`; LB: its range |
| Budget plugin and cost fields removed (P5) | Delete them; use `quotaTokens` |
| `rate-limit` `maxRequestsPerMinute` optional; own `rpm` exempts the key | Nothing (review limits) |
| Several keys per target, 429 pause / 401 disable, priority groups, `weight: 0` drains, `503 model_unavailable` (P4) | Give each target a key; review `priority` / `weight` |
| `/admin` writes need JSON + same origin (P4) | Send `Content-Type: application/json` from scripts |
| `NoUsableKeyError` (embedders, P4) | Catch it |
| Model limits enforced with 400; `developer` → `system` (P3) | Keep requests within the published model's metadata |
| Only published models served, `targets[].models` honoured (P2) | List models per target or add `models:` |
| Runtime sections imported once, then ignored | Change config in the console / API, or `config import --force`, or `source: file` |
| Literal `apiKey` needs `GATEWAY_SECRET_KEY` | Set it (or use `"${VAR}"` references) |
| `otlpProtocol: grpc`, `targets[].priority` / `budget`, strict built-in plugin configs, one duration parser | Remove the keys the error names; use `<int><unit>` durations |
| 0.2 console and `/admin/static/*` removed | Use `/admin/dashboard` (cookie sign-in) |

## Rolling back to 0.2.x

0.2.x does not read `config.sqlite`; it uses the config file again. Keep the file you imported from, restore the
data-directory backup (the key store gained columns through migrations that 0.2.x does not know), and remove any
0.3.0-only keys (`models:`, `limits:`, `console:`, `runtimeConfig:`, `apiKeys`) from the file.
