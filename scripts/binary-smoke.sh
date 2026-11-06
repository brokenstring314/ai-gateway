#!/usr/bin/env bash
# Smoke-test a standalone `bun build --compile` binary, run from an empty
# directory (no source tree, no node_modules):
#   version -> validate -> serve -> /livez + /readyz 200 -> console page and
#   embedded assets 200 -> key store (bun:sqlite) via `keys create --admin` ->
#   admin API accepts that key -> anonymous inference 401 -> SIGTERM exits.
# Usage: scripts/binary-smoke.sh <path-to-binary> [port]
set -euo pipefail

BIN="$(cd "$(dirname "${1:?usage: $0 <binary> [port]}")" && pwd)/$(basename "$1")"
PORT="${2:-38517}"
WORK="$(mktemp -d)"
PID=""

log() { printf '[bin-smoke] %s\n' "$*"; }
fail() {
  printf '[bin-smoke] FAIL: %s\n' "$*" >&2
  [ -f "$WORK/serve.log" ] && cat "$WORK/serve.log" >&2
  exit 1
}
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$WORK"
cat >config.yaml <<YAML
server:
  port: $PORT
  host: 127.0.0.1
strategy:
  mode: single
  targets: ["upstream"]
targets:
  - name: upstream
    provider: openai
    apiKey: "sk-smoke-upstream"
    baseURL: "http://127.0.0.1:9/v1"
    models: ["gpt-4o"]
auth:
  enabled: true
  keys: ["sk-smoke-client"]
adminSecret: "smoke-admin-secret-0123456789"
YAML

"$BIN" version | tee version.txt
grep -q '[0-9]\+\.[0-9]\+\.[0-9]\+' version.txt || fail "version printed nothing useful"
"$BIN" validate -c config.yaml || fail "validate failed"

BASE="http://127.0.0.1:$PORT"
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$@" || true; }

GATEWAY_SECRET_KEY="$(head -c 32 /dev/urandom | base64)" GATEWAY_DATA_DIR="$WORK/data" "$BIN" serve -c config.yaml >serve.log 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  [ "$(status "$BASE/livez")" = "200" ] && break
  kill -0 "$PID" 2>/dev/null || fail "binary exited during startup"
  sleep 0.5
done
[ "$(status "$BASE/livez")" = "200" ] || fail "/livez never returned 200"
code="$(status "$BASE/readyz")"; [ "$code" = "200" ] || fail "/readyz returned $code"

# Admin console (embedded Preact app): the page and every asset it references.
curl -sf --max-time 3 "$BASE/admin/dashboard" -o console.html || fail "/admin/dashboard not 200"
assets="$(grep -oE '/admin/dashboard/assets/[^"]+' console.html)"
[ -n "$assets" ] || fail "/admin/dashboard references no assets"
for path in $assets; do
  f="$(basename "$path")"
  curl -sf --max-time 3 "$BASE$path" -o "$f" || fail "$path not 200"
  [ "$(wc -c <"$f")" -gt 500 ] || fail "$path is suspiciously small"
done
grep -q 'aigw_csrf' ./*.js || fail "the console script is not the embedded console"

code="$(status -X POST -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' "$BASE/v1/chat/completions")"
[ "$code" = "401" ] || fail "anonymous /v1/chat/completions returned $code, expected 401"

ADMIN_KEY="$("$BIN" keys create --admin --name smoke -c config.yaml --data-dir "$WORK/data")" || fail "keys create failed"
[ -n "$ADMIN_KEY" ] || fail "keys create printed no key"
"$BIN" keys list -c config.yaml --data-dir "$WORK/data" | grep -q smoke || fail "keys list does not show the new key"
# Since 0.3.1 (FC-1) a running server picks up keys created by another process
# (the CLI) through a background PRAGMA data_version check every
# KEY_STORE_SYNC_INTERVAL_MS (default 1000 ms), not on the very next request.
# Wait past one interval, then retry at most 3 times: every 401 for a presented
# credential counts toward the per-IP lockout (5), so never poll faster.
sleep 1.5
code=""
for _ in 1 2 3; do
  code="$(status -H "Authorization: Bearer $ADMIN_KEY" "$BASE/admin/keys")"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || fail "GET /admin/keys with the CLI-created admin key returned $code (after waiting for the key-store sync)"
# Console sign-in: the admin key buys an HttpOnly session cookie.
curl -s --max-time 3 -D login.headers -o /dev/null -H 'content-type: application/json' \
  -d "{\"key\":\"$ADMIN_KEY\"}" "$BASE/admin/session/login" || fail "console login request failed"
grep -qi '^set-cookie: aigw_session=.*HttpOnly' login.headers || fail "console login did not set an HttpOnly session cookie"

kill -TERM "$PID"
for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PID" 2>/dev/null; then fail "binary still running 10s after SIGTERM"; fi
PID=""
log "OK: version, validate, livez/readyz, console + embedded assets, key store, admin auth, SIGTERM"
