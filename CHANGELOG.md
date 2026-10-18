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

### Security

- **`ADMIN_BOOTSTRAP_KEY` / `ADMIN_BOOTSTRAP_READ_ONLY_KEY` are retired once a
  real admin credential exists**: a usable admin key in the key store,
  `adminSecret`, or `auth.keys`. Previously they stayed valid as long as the
  key store was empty, so deployments using `adminSecret` or `auth.keys` kept a
  live admin backdoor. They still work on a first run with nothing configured,
  and inference-only store keys no longer retire them. The gateway logs
  `[auth] ... disabled: <reason>` when they are refused.
