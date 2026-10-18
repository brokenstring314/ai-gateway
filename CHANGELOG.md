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
