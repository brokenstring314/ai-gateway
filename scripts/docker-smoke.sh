#!/usr/bin/env bash
# Smoke-test a built gateway image:
#   start -> /livez 200 -> /readyz 200 -> non-root -> auth enforced ->
#   docker HEALTHCHECK healthy -> SIGTERM exits cleanly within the grace.
# Usage: scripts/docker-smoke.sh <image>   (e.g. aigw:ci)
set -euo pipefail

IMAGE="${1:?usage: $0 <image>}"
NAME="aigw-smoke-$$"
GRACE_MS=5000
WORK="$(mktemp -d)"

log() { printf '[smoke] %s\n' "$*"; }
fail() {
  printf '[smoke] FAIL: %s\n' "$*" >&2
  docker logs "$NAME" >&2 2>&1 || true
  exit 1
}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Minimal production-valid config: auth on with a client key, 16+ char admin
# secret. The upstream is never called by this script.
cat >"$WORK/config.yaml" <<'YAML'
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
chmod 644 "$WORK/config.yaml"

log "starting $IMAGE"
docker run -d --name "$NAME" \
  -p 127.0.0.1::3000 \
  -e SHUTDOWN_GRACE_MS="$GRACE_MS" \
  -v "$WORK/config.yaml:/config/config.yaml:ro" \
  "$IMAGE" >/dev/null

PORT="$(docker port "$NAME" 3000/tcp | head -n1 | awk -F: '{print $NF}')"
[ -n "$PORT" ] || fail "could not resolve the published port"
BASE="http://127.0.0.1:$PORT"

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$@" || true; }

log "waiting for /livez on $BASE"
for _ in $(seq 1 60); do
  [ "$(status "$BASE/livez")" = "200" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || fail "container exited during startup"
  sleep 0.5
done
[ "$(status "$BASE/livez")" = "200" ] || fail "/livez never returned 200"

code="$(status "$BASE/readyz")"
[ "$code" = "200" ] || fail "/readyz returned $code, expected 200"

uid="$(docker exec "$NAME" id -u)"
[ "$uid" != "0" ] || fail "container runs as root"

code="$(status -X POST -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' "$BASE/v1/chat/completions")"
[ "$code" = "401" ] || fail "anonymous /v1/chat/completions returned $code, expected 401"

log "waiting for docker HEALTHCHECK to report healthy"
health=""
for _ in $(seq 1 45); do
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME")"
  [ "$health" = "healthy" ] && break
  [ "$health" = "unhealthy" ] && fail "HEALTHCHECK reported unhealthy"
  sleep 1
done
[ "$health" = "healthy" ] || fail "HEALTHCHECK not healthy after 45s (status: ${health:-none})"

log "sending SIGTERM (docker stop)"
start="$(date +%s)"
# docker stop sends STOPSIGNAL (SIGTERM), then SIGKILL after -t seconds.
docker stop -t 20 "$NAME" >/dev/null
elapsed=$(( $(date +%s) - start ))
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
oom="$(docker inspect -f '{{.State.OOMKilled}}' "$NAME")"
[ "$oom" = "false" ] || fail "container was OOM-killed"
# 137 = SIGKILL (the stop timeout ran out); 0 or 143 = exited on SIGTERM.
case "$exit_code" in
  0 | 143) ;;
  *) fail "exit code $exit_code after SIGTERM (137 means it had to be killed)" ;;
esac
max=$(( GRACE_MS / 1000 + 5 ))
[ "$elapsed" -le "$max" ] || fail "shutdown took ${elapsed}s (limit ${max}s)"

log "OK: livez/readyz 200, uid $uid, auth enforced, healthy, SIGTERM exit $exit_code in ${elapsed}s"
