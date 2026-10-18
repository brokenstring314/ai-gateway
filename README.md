# AI Gateway

A high-performance OpenAI-compatible API gateway built with TypeScript, Bun, and Hono.

Route requests across 20+ LLM providers through a single unified endpoint, with 4 routing strategies, 6 built-in plugins (incl. a PII & secret guardrail), circuit breakers, retry with backoff, MCP agentic tool calling, and full observability.

> **Acknowledgement:** the design of this project originates from [Ferro Labs AI Gateway](https://github.com/ferro-labs/ai-gateway) (Apache-2.0). Thanks to the Ferro Labs team; see [NOTICE](NOTICE).

---

## Quick Start

### Install

**Docker image** (linux/amd64, linux/arm64) from GitHub Container Registry:

```bash
docker pull ghcr.io/brokenstring314/ai-gateway:0.2.0   # or :0.2, :latest
docker run -d --name ai-gateway -p 3000:3000 \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -v ai-gateway-data:/data \
  -e OPENAI_API_KEY \
  ghcr.io/brokenstring314/ai-gateway:0.2.0
```

See [Docker](#docker) below for what the image expects (production mode, auth on).

**Prebuilt binary** (single file, no Bun needed): download the archive for your
platform from [Releases](https://github.com/brokenstring314/ai-gateway/releases)
(`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` as `.tar.gz`,
`windows-x64` as `.zip`). Each archive holds the `ai-gateway` binary, LICENSE,
NOTICE, README.md and `config.example.yaml`.

```bash
V=0.2.0 P=linux-x64
curl -LO https://github.com/brokenstring314/ai-gateway/releases/download/v$V/ai-gateway-$V-$P.tar.gz
curl -LO https://github.com/brokenstring314/ai-gateway/releases/download/v$V/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
tar xzf ai-gateway-$V-$P.tar.gz && cd ai-gateway-$V-$P
./ai-gateway serve -c config.yaml     # start from config.example.yaml
```

The binaries are not code-signed. On macOS, clear the quarantine flag first:
`xattr -d com.apple.quarantine ./ai-gateway`.

**From source** (needs [Bun](https://bun.sh/) 1.4.3+): see below.

### Run from source

```bash
git clone https://github.com/brokenstring314/ai-gateway.git && cd ai-gateway
bun install
```

Create a config file:

```yaml
# config.yaml
apiVersion: v1
server:
  port: 3000
strategy:
  mode: single
  targets: ["my-openai"]
targets:
  - name: my-openai
    provider: openai
    apiKey: "sk-your-key-here"
    models: ["gpt-4o", "gpt-4o-mini"]
```

Start the gateway:

```bash
bun run src/index.ts serve -c config.yaml
```

Test it:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Docker

```bash
docker build -t ai-gateway .
docker run -d --name ai-gateway -p 3000:3000 \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -v ai-gateway-data:/data \
  -e OPENAI_API_KEY \
  ai-gateway
```

The image runs as a non-root user (uid 1000) under `tini`, with
`GATEWAY_ENV=production` (so the config must enable auth with at least one key;
an `adminSecret` must be 16+ characters) and `GATEWAY_DATA_DIR=/data` (API keys
and request logs; mount a volume to keep them). Mount the config at
`/config/config.yaml` (read-only is fine). The built-in `HEALTHCHECK` probes
`/livez` on port 3000; point your load balancer / k8s readiness probe at
`/readyz`. `docker stop` sends SIGTERM: `/readyz` turns 503, new connections are
refused and in-flight requests drain for `SHUTDOWN_GRACE_MS` (default 10000).
`scripts/docker-smoke.sh <image>` is the smoke test CI runs against the image.

---

## CLI Reference

```
Usage:
  ai-gateway serve    -c <config.yaml> [-p <port>] [-h <host>]
  ai-gateway validate -c <config.yaml>
  ai-gateway keys create [--admin] [--read-only] [--name <name>] [--expires <ISO>] [--json] -c <config.yaml>
  ai-gateway keys list [--json] -c <config.yaml>
  ai-gateway keys revoke <id> -c <config.yaml>
  ai-gateway version

Commands:
  serve      Start the gateway server
  validate   Validate a config file and report errors
  keys       Manage the API key store directly (works with the server stopped or running)
  version    Print version

Options:
  -c, --config <path>   Config file path (YAML or JSON)
  -p, --port <port>     Override server.port
  -h, --host <host>     Override server.host
  --data-dir <dir>      (keys) Data directory; default GATEWAY_DATA_DIR or ./.data
```

`--help` (or `help`) prints this text, `ai-gateway keys --help` the `keys` options; `--version` / `-v` is the same as `version`. `-h` always means `--host`. Unknown options are an error.

`ai-gateway serve`, `bun src/index.ts serve` and `bun src/cli/index.ts serve` are the same CLI and start the server through one `bootstrap()` (key store, production-safety checks, client auth, OpenTelemetry, graceful shutdown). Embedders can call `bootstrap(configPath, { port, host, dataDir })` from the package entry point; it returns a handle with `stop()`.

### Examples

```bash
# Start serving
ai-gateway serve -c config.yaml

# Validate config without starting
ai-gateway validate -c config.yaml

# Recover admin access (works while the server is running); prints the key once
ai-gateway keys create --admin --name ops-recovery -c config.yaml

# Print version
ai-gateway version
```

---

## Configuration

The gateway reads configuration from a YAML or JSON file. All settings can be overridden via environment variables prefixed with `AI_GATEWAY_`.

### Minimal Config

```yaml
strategy:
  mode: single
  targets: ["my-provider"]
targets:
  - name: my-provider
    provider: openai
    apiKey: "sk-..."
```

### Full Config Reference

```yaml
apiVersion: v1

server:
  port: 3000                # HTTP port (default: 3000)
  host: "0.0.0.0"          # Bind address (default: 0.0.0.0)
  idleTimeoutSeconds: 255   # Bun idle timeout; 0 = never, max/default 255
  sseHeartbeatSeconds: 5    # SSE ": ping" comment while a stream is idle (default 5); 0 = off
  streamIdleTimeoutSeconds: 120  # end a stream when upstream sends nothing this long (default 120); 0 = off
  streamMaxDurationSeconds: 0    # hard cap on one stream's duration; 0 = off (default)
  perIpRateLimit:           # per-client-IP token bucket on /v1/*; OFF unless rps > 0
    rps: 50                 #   sustained requests/second per IP (env RATE_LIMIT_RPS overrides)
    burst: 100              #   bucket size, default 2 × rps (env RATE_LIMIT_BURST overrides)

passthroughProxy:
  enabled: false            # forward other /v1/* routes upstream (see API Endpoints)
  # routes: ["POST /v1/responses", "POST /v1/moderations", "POST /v1/audio/*"]  # default allow-list

strategy:
  mode: single              # single | fallback | loadbalance | conditional
  targets: ["openai-main"]  # Target names for the strategy
  weights:                  # Per-target weights (loadbalance; 0 = drained)
    openai-main: 3
    deepseek-backup: 1
  rules:                    # Conditional routing rules (first match wins)
    - field: "model"        # model | user | message | prompt
      pattern: "^gpt-4"     # regex, or contains: "<substring>"
      target: "openai-main"

targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."                        # may be "${OPENAI_API_KEY}"
    baseURL: "https://api.openai.com/v1"   # Optional, has per-provider defaults
    models: ["gpt-4o", "gpt-4o-mini"]
    weight: 3                               # For loadbalance strategy (0 = drained)
    costPer1kInputTokens: 0.005             # Pricing (budget plugin / metrics)
    costPer1kOutputTokens: 0.015
    retry:                                  # Per-target retry (no block = 1 attempt, no retry)
      attempts: 3                           # Max attempts (default when the block is present: 3)
      initialBackoffMs: 100                 # Base backoff in ms (default: 100)
      onStatusCodes: [408, 429, 500, 502, 503, 504]  # Retryable status codes (this is the default)
    circuitBreaker:                         # Per-target circuit breaker
      failureThreshold: 5                   # Consecutive failures before open (default: 5)
      successThreshold: 1                   # Successes in half-open to close (default: 1)
      maxHalfThreshold: 1                   # Concurrent probes allowed in half-open (default: 1)
      timeoutMs: 30000                      # Open → half-open timeout (default: 30000)
    concurrency:                            # Per-target concurrency limit (off unless set)
      maxConcurrency: 20                    # In-flight upstream calls (1–10000)
      queueSize: 1000                       # Waiting requests beyond that (default: 1000; full → 429)

  - name: deepseek-backup
    provider: deepseek
    apiKey: "sk-..."
    models: ["deepseek-chat"]

auth:
  enabled: true             # on unless explicitly false
  keys:
    - "sk-my-api-key-1"
    - "sk-my-api-key-2"

adminSecret: "a-secure-admin-secret-at-least-8-chars"   # 8+ chars (16+ with GATEWAY_ENV=production)

cors:
  enabled: true
  origins:
    - "https://my-app.example.com"
    - "http://localhost:3000"
  # allowHeaders: [...]     # default: reflect Access-Control-Request-Headers

maxRequestBytes: 10485760       # 10 MB body limit (default)
requestTimeout: "30s"           # 30s (default), 5m, 1h

aliases:
  fast: "gpt-4o-mini"
  smart: "gpt-4o"

plugins:                        # run in this order; see Plugins for every option
  - name: rate-limit
    stage: before_request
    config:
      maxRequestsPerMinute: 60
  - name: word-filter
    stage: before_request
    config:
      blockedWords: ["forbidden", "blocked"]
      mode: reject              # reject (default) | redact
  - name: max-token
    stage: before_request
    config:
      maxTokens: 4096
  - name: cache
    stage: before_request
    config:
      maxAge: 300
      maxEntries: 1000
  - name: budget
    stage: before_request
    config:
      dailyBudget: 100
      costPer1kInput: 0.01
      costPer1kOutput: 0.03

compatibility:
  onUnsupportedParam: warn      # warn | drop | reject

mcpServers:
  - name: my-tools
    type: stdio                 # stdio is the only transport
    command: "node"
    args: ["my-mcp-server.js"]
    # env: {...}  inheritEnv: [...]  allowedTools: [...]
    # maxCallDepth: 5  timeoutSeconds: 30  required: false

observability:
  tracing:
    enabled: true
    otlpEndpoint: "http://localhost:4318/v1/traces"   # full OTLP/HTTP traces URL
    serviceName: "ai-gateway"
    sampleRatio: 1.0            # 0–1 (default 1.0)
    privacyLevel: metadata      # none | metadata (default) | full
    # headers: {...}  shutdownGrace: "10s"
  metrics:
    enabled: true
    port: 9090
```

### Environment Variable Overrides

Any config field can be overridden with `AI_GATEWAY_` prefix, using `_` as path separator:

```bash
AI_GATEWAY_SERVER_PORT=8080
AI_GATEWAY_AUTH_ENABLED=true
AI_GATEWAY_MAX_REQUEST_BYTES=20971520   # camelCase keys: maxRequestBytes
AI_GATEWAY_CORS_ORIGINS=https://a.example,https://b.example   # arrays: comma-separated
```

Segments match config keys case-insensitively (consecutive segments join into camelCase keys).
Values take the field's type, so string fields like `apiKey` and `adminSecret` are never converted to numbers.
A variable that does not name a config key is ignored with a warning.

### Operational Environment Variables

These are read directly from the environment (not via `AI_GATEWAY_*`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_DATA_DIR` | `.data` (relative to the working directory) | Where the SQLite databases live (see below). Put it on a persistent volume. |
| `GATEWAY_ENV` | unset | `production` turns on the startup safety guard: refuses `auth.enabled: false`, `ALLOW_UNAUTHENTICATED_PROXY=true`, an `adminSecret` shorter than 16 chars, and starting with no client key at all (no `auth.keys` and an empty key store). |
| `ADMIN_BOOTSTRAP_KEY` | unset | First-run admin credential; refused once a real admin credential exists, permanently once an admin key has been created (see [Key scopes](#key-scopes-key-store-mode)). |
| `ADMIN_BOOTSTRAP_READ_ONLY_KEY` | unset | Same, with `read_only` scope. |
| `ALLOW_UNAUTHENTICATED_PROXY` | `false` | `true` lets the opt-in pass-through proxy forward requests without a client key. Refused when `GATEWAY_ENV=production`. |
| `RATE_LIMIT_RPS` | unset (limiter off) | Per-client-IP limit on `/v1/*`, requests/second. Overrides `server.perIpRateLimit.rps`. `0` disables. |
| `RATE_LIMIT_BURST` | 2 × rps | Per-IP bucket size. Overrides `server.perIpRateLimit.burst`. |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Comma-separated IPs/CIDRs whose `X-Forwarded-For` / `X-Real-IP` are trusted for the per-IP limiter. Set it to your load balancer's range, otherwise every request behind it shares the LB's IP. |
| `SHUTDOWN_GRACE_MS` | `10000` | How long SIGTERM/SIGINT waits for in-flight requests before closing. Shutdown order: `/readyz` → 503 and new requests on open connections → 503 `shutting_down`; the listener stops accepting new connections; in-flight requests finish (their responses carry `Connection: close`); then the listener and stores are closed. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP HTTP endpoint when `observability.tracing.otlpEndpoint` is not set. |
| `OTEL_TRACES_SAMPLER` | unset | `always_on`, `always_off` or `traceidratio` (uses `sampleRatio`); other values are ignored. |

**Per-IP rate limiting** is off by default. When the gateway is exposed directly, enable it with `server.perIpRateLimit` (or `RATE_LIMIT_RPS`); behind a load balancer, also set `TRUSTED_PROXIES`. Over-limit requests get `429` with `{"error": {"code": "rate_limited", ...}}` and a `Retry-After` header (seconds). Buckets are per process and idle ones are evicted.

**Data directory (`GATEWAY_DATA_DIR`, default `./.data`)** contains:

- `api-keys.sqlite` — the API key store: SHA-256 hashes of keys (never the keys themselves), display prefixes, names, scopes, expiry and usage counters. Losing it revokes every store key; anyone who can write to it can mint keys, so keep it private (`chmod 700` the directory).
- `request-logs.sqlite` — request log for `/admin/logs`: trace id, model, provider, token counts and error messages (no prompts or completions). Error messages can quote upstream responses.
- `gateway-config.sqlite` — only from versions before 0.2.0; ignored (a warning is printed) and safe to delete.

---

## Supported Providers

All providers use the OpenAI-compatible protocol. The gateway adapts request/response formats per provider.

| Provider      | Default Base URL                                    |
| ------------- | --------------------------------------------------- |
| `openai`      | `https://api.openai.com/v1`                         |
| `deepseek`    | `https://api.deepseek.com/v1`                       |
| `groq`        | `https://api.groq.com/openai/v1`                    |
| `mistral`     | `https://api.mistral.ai/v1`                         |
| `xai`         | `https://api.x.ai/v1`                               |
| `qwen`        | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `moonshot`    | `https://api.moonshot.cn/v1`                        |
| `together`    | `https://api.together.xyz/v1`                       |
| `fireworks`   | `https://api.fireworks.ai/inference/v1`             |
| `deepinfra`   | `https://api.deepinfra.com/v1/openai`               |
| `ai21`        | `https://api.ai21.com/studio/v1`                    |
| `cerebras`    | `https://api.cerebras.ai/v1`                        |
| `sambanova`   | `https://api.sambanova.ai/v1`                       |
| `novita`      | `https://api.novita.ai/v3/openai`                   |
| `nvidia_nim`  | `https://integrate.api.nvidia.com/v1`               |
| `ollama`      | `http://localhost:11434/v1`                         |
| `openrouter`  | `https://openrouter.ai/api/v1`                      |
| `perplexity`  | `https://api.perplexity.ai`                         |
| `replicate`   | `https://api.replicate.com/v1`                      |
| `cloudflare`  | none: set `baseURL` (`https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`) |
| `databricks`  | none: set `baseURL` (`https://<workspace>.cloud.databricks.com/serving-endpoints`) |
| `huggingface` | `https://api-inference.huggingface.co/v1`           |

Any unknown provider with an explicit `baseURL` is treated as a generic OpenAI-compatible endpoint; an unknown provider without one fails `validate` and startup. Provider names are case-insensitive; `nvidia-nim` and `nim` are aliases of `nvidia_nim`, `x-ai` of `xai`, `dashscope` of `qwen`. `openrouter` targets send an `HTTP-Referer` / `X-Title` attribution header. `baseURL` may contain `${VAR}` references (e.g. `"${OPENAI_BASE_URL}"`, `"http://localhost:${PORT}/v1"`); the expanded value must be an http(s) URL.

Parameter support is looked up by `provider` (the preset), not by the target's `name`, so a target called `my-mistral` with `provider: mistral` gets Mistral's capability checks (see [Compatibility Mode](#compatibility-mode)).

---

## API Endpoints

### Chat Completions

```
POST /v1/chat/completions
```

Full OpenAI Chat Completions API compatibility, including:

- Streaming (`"stream": true`) with SSE
- Function calling / tools (`tools`, `tool_choice`)
- Response formats (`text`, `json_object`, `json_schema`)
- `logprobs` and `top_logprobs`
- `seed` for deterministic outputs
- `stream_options.include_usage` for usage in final chunk
- `max_tokens` / `max_completion_tokens`
- `parallel_tool_calls`
- `tools[].function.strict`
- Allow-listed pass-through of fields the gateway does not model, in both
  directions. Request: `reasoning_effort`, `verbosity`, `store`, `metadata`,
  `modalities`, `audio`, `prediction`, `service_tier`, `web_search_options`,
  `prompt_cache_key`, `safety_identifier` and common provider knobs (`top_k`,
  `min_p`, `repetition_penalty`, `reasoning`, `thinking`, `enable_thinking`,
  `chat_template_kwargs`, Perplexity `search_*` / `return_*`); message
  `reasoning_content` / `reasoning` / `refusal` / `audio` / `prefix`.
  Response and stream chunks: `system_fingerprint`, `service_tier`,
  `citations`, `search_results`; `choices[].logprobs`; message / delta
  `reasoning_content`, `reasoning`, `refusal`, `annotations`, `audio`; usage
  `prompt_tokens_details`, `completion_tokens_details`, `cost`. Other unknown
  keys are dropped.

**Request:**

```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false
}
```

**Non-streaming response:**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "gpt-4o",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello! How can I help?"},
    "logprobs": null,
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 15, "completion_tokens": 8, "total_tokens": 23}
}
```

**Streaming response** (`"stream": true`):

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"!"},"logprobs":null,"finish_reason":"stop"}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":15,"completion_tokens":2,"total_tokens":17}}

data: [DONE]
```

### Legacy Completions

```
POST /v1/completions
```

OpenAI legacy completions wire format. The prompt becomes a single user
message and runs through the chat pipeline (plugins, routing, fallback). The
standard snake_case parameters are honoured (`max_tokens`, `top_p`,
`presence_penalty`, `frequency_penalty`, `logit_bias`, `stop`, `n`, `seed`,
`user`, `stream_options`; integer `logprobs` maps to chat `top_logprobs`).
The response is a `text_completion` (`choices[].text`, `finish_reason`,
legacy `logprobs` with `tokens` / `token_logprobs` / `top_logprobs` /
`text_offset`, snake_case `usage`); stream chunks have the same shape.
Options chat cannot express are rejected with 400 `validation_failed`:
`echo: true`, a non-empty `suffix`, `best_of` > 1, and batched prompts (an
array of more than one prompt).

```json
{"id":"cmpl-1","object":"text_completion","created":1700000000,"model":"gpt-3.5-turbo-instruct",
 "choices":[{"text":"Hello!","index":0,"logprobs":null,"finish_reason":"stop"}],
 "usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}
```

### Embeddings

```
POST /v1/embeddings
```

```json
{
  "model": "text-embedding-3-small",
  "input": "Hello world"
}
```

### Image Generation

```
POST /v1/images/generations
```

```json
{
  "model": "dall-e-3",
  "prompt": "A sunset over mountains",
  "n": 1,
  "size": "1024x1024"
}
```

### Model List

```
GET /v1/models
```

Returns all models across all configured providers:

```json
{
  "object": "list",
  "data": [
    {"id": "gpt-4o", "object": "model", "owned_by": "openai-main"},
    {"id": "deepseek-chat", "object": "model", "owned_by": "deepseek-backup"}
  ]
}
```

### Capabilities

```
GET /v1/capabilities
```

Returns per-provider parameter support profiles (which OpenAI parameters each provider supports).

### Other `/v1/*` routes (pass-through proxy, opt-in)

Paths are normalized before routing: duplicate slashes, a trailing slash, `%2F`
and case variants of the routes above (e.g. `/v1/chat/completions/`,
`/v1//chat/completions`, `/V1/Chat/Completions`) are served by the real
handlers, so they always get plugins, circuit breakers and fallback.

Another method on one of these routes (e.g. `GET /v1/chat/completions`,
`DELETE /v1/completions`) answers **405** `method_not_allowed` with an `Allow`
header; it is never proxied.

Any other `/v1/*` route (e.g. `/v1/responses`, `/v1/files`) returns **404**
unless the pass-through proxy is enabled:

```yaml
passthroughProxy:
  enabled: true   # default: false
  routes:         # method+path allow-list; this is the default
    - POST /v1/responses
    - POST /v1/moderations
    - POST /v1/audio/*       # /* = any sub-path
```

Only allow-listed routes are forwarded; anything else gets **403**
`route_not_allowed`. The default allows only stateless POST endpoints: every
proxied request uses the target's single upstream key, so routes that list,
read or delete stored objects (`GET /v1/files`, `DELETE /v1/files/{id}`,
`GET /v1/responses/{id}`, batches, vector stores, stored chat completions)
would let one client reach every other client's data. Add such routes only
when the gateway serves a single tenant. Entries are `"METHOD /v1/path"` or
`"METHOD /v1/prefix/*"` (`*` as method = any method); paths with encoded
slashes are never forwarded.

When enabled, the request is forwarded verbatim to the target chosen by the
`X-Provider` header or the body's top-level `model`, after the
**before-request plugins** run on it (rate-limit, budget check, word-filter on
`messages` / `input` / `prompt` / `instructions`; max-token on
`max_output_tokens` / `max_tokens` / `max_completion_tokens`, injecting
`max_output_tokens` on `/v1/responses` when the client omitted it). Because
the body shape is unknown, a plugin that would rewrite content (word-filter
`redact`) or short-circuit causes a 403 instead; a capped token limit is
written into the forwarded body. Proxied requests do **not** get circuit
breakers, fallback, after-request plugins or budget accrual, which is why the
proxy is off by default.

### Health Probes

| Endpoint      | Purpose                                      | Status Codes |
| ------------- | -------------------------------------------- | ------------ |
| `GET /health` | General health check                         | 200          |
| `GET /livez`  | Process liveness (Kubernetes liveness probe). 503 only when a `required` MCP server has failed 5 consecutive reconnect attempts, so the orchestrator restarts the pod | 200 / 503    |
| `GET /readyz` | Readiness: config + providers loaded, SQLite stores (key store, request-log store) reachable, required MCP servers up, not draining. Upstream circuit-breaker state does **not** affect readiness (every replica shares the same upstreams; failing readiness would pull the whole fleet); it is reported in the body as `circuitBreakers` / `upstreamAvailable`. Returns 503 immediately once SIGTERM/SIGINT drain starts, and new requests are refused with 503 during the drain | 200 / 503    |

### Metrics

```
GET /metrics
```

Prometheus-format metrics including:

- `ai_gateway_requests_total{method, status, provider}` — HTTP request counter
- `ai_gateway_request_duration_seconds{method, status, provider}` — latency histogram
- `ai_gateway_tokens_input_total{provider, model}` — input token counter (every surface that reports usage)
- `ai_gateway_tokens_output_total{provider, model}` — output token counter
- `ai_gateway_plugin_blocked_total{plugin, outcome, surface}` — requests ended by a plugin

Full list: [Prometheus Metrics](#prometheus-metrics).

### Admin API

Admin endpoints accept, in key-store mode (`ai-gateway serve`): the `adminSecret` (as `X-Admin-Secret` or `Authorization: Bearer`), a key-store key with `admin` or `read_only` scope (`Authorization: Bearer`), or a bootstrap key while it is still allowed (see below). Inference-only keys get 403 `insufficient_scope`; every mutating route needs `admin`. Without a key store (embedded `createApp(gateway, config)`) only `adminSecret` is accepted, and with no `adminSecret` the admin API answers 403 `admin_disabled`.

| Method | Path                      | Scope      | Description                            |
| ------ | ------------------------- | ---------- | -------------------------------------- |
| GET    | `/admin/config`           | read_only  | Current config (secrets redacted: API keys, admin secret, client keys, URL credentials, OTLP headers, MCP env/args, secret-looking plugin config; exact `${VAR}` templates are shown as-is) |
| GET    | `/admin/keys`             | read_only  | List API keys (never plaintext)        |
| GET    | `/admin/keys/usage`       | read_only  | Usage counters: `totalKeys`, `totalUsageCount`, per-key `usageCount` |
| GET    | `/admin/keys/:id`         | read_only  | One key                                |
| POST   | `/admin/keys`             | admin      | Create a key (`{"name", "scopes"?, "expiresAt"?}`); the key is returned once |
| PUT    | `/admin/keys/:id`         | admin      | Update name and scopes (`{"name", "scopes"}`) |
| POST   | `/admin/keys/:id/revoke`  | admin      | Revoke a key                           |
| POST   | `/admin/keys/:id/rotate`  | admin      | Replace a key's secret (new key returned once) |
| DELETE | `/admin/keys/:id`         | admin      | Delete a key                           |
| GET    | `/admin/logs`             | read_only  | Request log, newest first; `limit` (≤200), `offset`, filters `stage` (surface), `model`, `provider` (target), `since`, `status=error\|ok` |
| GET    | `/admin/logs/stats`       | read_only  | Counts by surface/target/model, errors, tokens (same filters) |
| DELETE | `/admin/logs?before=<ISO>`| admin      | Purge persisted log entries older than `before` (optional `stage` / `model` / `provider`) |
| GET    | `/admin/status`           | read_only  | Console overview: caller `scopes`, `circuitBreakers` per target, `upstreamAvailable`, `mcpServers`, in-process request summary (count, 4xx/5xx, error rate, latency mean/p50/p95) |

Without a key store, `GET` / `POST` / `DELETE /admin/keys` manage the in-memory `auth.keys` list instead (`POST {"key": "sk-..."}`, delete by list index; lost on restart).

The config is read-only at runtime: there is no hot reload and no config write API (removed in 0.2.0; the old write routes answer `410 config_api_removed`). To change config, edit the file and restart (rolling restart behind a load balancer). `SIGHUP` is logged and ignored.

**Example:**

```bash
# Get config
curl -H "X-Admin-Secret: my-secret" http://localhost:3000/admin/config

# Create an inference key (key-store mode); the response carries the key once
curl -X POST \
  -H "X-Admin-Secret: my-secret" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "scopes": ["inference"]}' \
  http://localhost:3000/admin/keys
```

#### Key scopes (key-store mode)

When the server runs with the API key store (`ai-gateway serve` / `bun src/index.ts serve`), `POST /admin/keys` takes `{"name": "...", "scopes": [...], "expiresAt"?: "..."}` and returns the generated key once. Scopes:

| Scope       | `/v1/*` | `GET /admin/*` | Mutating `/admin/*` |
| ----------- | ------- | -------------- | ------------------- |
| `inference` | yes     | 403            | 403                 |
| `read_only` | yes     | yes            | 403                 |
| `admin`     | yes     | yes            | yes                 |

A key created without `scopes` (or with `[]`) gets `["inference"]`: admin access must be requested explicitly with `"scopes": ["admin"]`. Any other value (non-array, non-string entries, unknown names) is rejected with 400 on create and update. Keys created by older versions without scopes were stored as `["admin"]`; review them with `GET /admin/keys` and downgrade with `PUT /admin/keys/:id {"scopes": ["inference"]}`.

`ADMIN_BOOTSTRAP_KEY` / `ADMIN_BOOTSTRAP_READ_ONLY_KEY` exist only for the first run. They are accepted (with `admin` / `read_only` scope) only while **no real admin credential exists**, and are refused as soon as any of these holds:

- an admin key has been created in the key store (the **bootstrap latch**, below), e.g. by `POST /admin/keys {"name": "ops", "scopes": ["admin"]}`;
- `adminSecret` is configured;
- `auth.keys` are configured.

Inference-only or `read_only` store keys do not retire them (otherwise creating a client key first would lock you out of the admin API). The check runs on every request, so the bootstrap key stops working the moment the first admin key is created. Startup prints a warning while the bootstrap key is live, and the gateway logs `[auth] ADMIN_BOOTSTRAP_KEY / ADMIN_BOOTSTRAP_READ_ONLY_KEY disabled: <reason>` when it is refused (at startup or at runtime). Remove the variables from the environment once you have an admin credential. Without a key store (embedded `createApp(gateway, config)`) they are never accepted.

**Bootstrap latch (one-way).** The first time an admin-scoped key exists in the key store (created with the bootstrap key, with `adminSecret`, by a `PUT` granting `admin`, or by the CLI), the store records it in the same transaction as the key write. From then on the bootstrap keys are refused **for good** with the same 401 as an invalid key, even if every admin key is later revoked, expires or is deleted. A key store from an older version that already contains any admin key (active, revoked or expired) is latched when it is upgraded. If two requests authenticated with the bootstrap key create admin keys at the same time, only the first succeeds. While latched, a still-set `ADMIN_BOOTSTRAP_KEY` produces one startup line: `... permanently disabled: bootstrap latch is set ... remove them from the environment`.

#### Recovering admin access

If no admin credential works any more (all admin keys revoked or expired, no `adminSecret`), mint a new admin key on the gateway host with the CLI. It opens the same key store as `serve` (`<data dir>/api-keys.sqlite`; data dir = `--data-dir`, `GATEWAY_DATA_DIR` or `./.data`) and is safe to run while the server is up (WAL mode, busy timeout); the server accepts the new key on the next request:

```bash
GATEWAY_DATA_DIR=/var/lib/ai-gateway ai-gateway keys create --admin --name ops-recovery -c config.yaml
# stdout: the new key, printed once (use --json for id/name/scopes too); details go to stderr
ai-gateway keys list -c config.yaml            # ids, names, scopes, status, latch state; never secrets
ai-gateway keys revoke <id> -c config.yaml
```

Options: `--expires 2027-01-01T00:00:00Z`, `--read-only` (instead of `--admin`; neither = `inference`). The command validates the config but never prints it or any secret except the new key; it refuses to create a store where none exists, so a wrong data directory fails loudly. In Docker: `docker exec <container> bun src/index.ts keys create --admin -c /config/config.yaml` (the image sets `GATEWAY_DATA_DIR=/data`).

### Admin console

A small built-in web console at **`/admin/dashboard`** (no build step, no framework, no external assets):

| Page | Shows | Data from |
| ---- | ----- | --------- |
| Overview (`/admin/dashboard`) | Readiness, per-target circuit breakers, `upstreamAvailable`, MCP server states, request counts / error rate / latency, requests by surface, target and model; refreshes every 15 s | `/readyz`, `/admin/status`, `/admin/logs/stats` |
| API keys (`/admin/dashboard/keys`) | Key list with scopes, status, expiry, usage. Admins can create keys (scopes `inference` / `read_only` / `admin`, optional expiry; the new key is shown once), rotate and revoke. `read_only` sees the list only | `/admin/keys` |
| Request logs (`/admin/dashboard/logs`) | Paginated log (50 per page), filter by surface, target, model, status (ok/error) and time | `/admin/logs` |
| Config (`/admin/dashboard/config`) | The running config, secrets scrubbed, read-only | `/admin/config` |

**Sign in** at `/admin/dashboard/login` with an `admin` or `read_only` key from the key store (or the `adminSecret`). The key stays in that tab's `sessionStorage` and is sent as `Authorization: Bearer`; no cookies are used. Closing the tab or "Sign out" forgets it. Inference-only keys are refused (403).

The HTML pages and `/admin/static/console.{js,css}` are served without auth because they contain no data (a browser navigation cannot carry a Bearer header); every number on them comes from the authenticated admin API above. Pages carry a strict CSP (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`, no inline script), and the script only inserts API data as text, never as HTML. Expose `/admin/*` only on networks you trust, as with the rest of the admin API.

The request numbers on Overview come from two places: "Logged requests" and the per-surface tables from the request-log store (survives restarts); "Upstream-served" and latency from this process's Prometheus registry since start (latency percentiles are histogram bucket bounds). Use `/metrics` for history.

### Response Headers

The gateway adds these headers to responses:

| Header                   | Description                                   |
| ------------------------ | --------------------------------------------- |
| `X-Gateway-Provider`     | Name of the provider that handled the request |
| `X-Gateway-Target`       | On error responses: the target that produced the error (never in the body) |
| `X-Gateway-Overhead-Ms`  | Gateway processing time in milliseconds       |
| `X-Content-Type-Options` | `nosniff`                                     |
| `X-Frame-Options`        | `DENY`                                        |
| `Referrer-Policy`        | `strict-origin-when-cross-origin`             |

### Error Responses

Every `/v1` endpoint answers errors in the OpenAI shape
`{"error": {"message", "type", "code", "param"}}`. Target names and upstream
URLs never appear in the body; the failing target is in the
`X-Gateway-Target` header and in the server log.

| Situation | Status | `code` |
| --- | --- | --- |
| Invalid JSON / validation | 400 | `invalid_json` / `validation_failed` |
| Model not served by any target | 404 | `model_not_found` |
| Plugin rejection (word-filter, …) | 403 | `plugin_rejected` |
| `pii-secret-guard` block (request / response) | 400 / 422 | `secret_detected` / `pii_detected` |
| `rate-limit` / `budget` plugin rejection | 429 + `Retry-After` (rate-limit) | `plugin_rejected` |
| Upstream 4xx (400, 404, 413, 422, …) | same status | upstream `code`; upstream `message`/`type`/`param` kept |
| Upstream 429 | 429 + upstream `Retry-After` | upstream `code` (default `rate_limit_exceeded`) |
| Upstream 401/403 (after failover) | 502 | `upstream_auth_failed` |
| Upstream 5xx | 502 | upstream `code` (default `upstream_error`) |
| Network error / reset / non-JSON 200 body | 502 | `upstream_unavailable` / `upstream_invalid_response` |
| Every candidate's circuit breaker open | 503 + `Retry-After` | `circuit_open` |
| Local concurrency queue full | 429 | `gateway_overloaded` |
| Gateway request timeout | 504 | `gateway_timeout` |
| Anything else | 500 | `Internal server error` (fixed message) |

When several targets were tried, the most meaningful error is returned:
upstream 4xx > upstream 429 > upstream 401/403 > timeout > upstream 5xx >
network error > local overload > circuit open.

---

## Routing Strategies

Four strategies are available: `single`, `fallback`, `loadbalance` and
`conditional` (`least_latency`, `cost_optimized`, `content_based` and `abtest`
were removed in 0.2.0, see [Removed strategies](#removed-strategies-020)).
Every strategy only produces an **ordered
candidate list** (its preferred target first); one shared executor
(`src/core/executor.ts`) runs it: a candidate whose circuit breaker is open, that hits its
concurrency limit (queue full, or the request deadline fires while queued —
answered 429 `gateway_overloaded` and never counted against the breaker), or that fails with a failover-eligible error (network,
5xx, 408, 429, 401/403/404) is skipped and the next candidate is tried, using
each target's own `retry` config. Caller-caused 4xx (400/409/413/422...),
client aborts and the gateway request timeout end the request. Streams fail
over only before their first chunk. Conditional fails over
from the matched target to the default target only. `/v1/embeddings` and
`/v1/images/generations` use the same strategy order (filtered to targets
that support the model and capability), with the same breakers, concurrency
limits, retry and failover; streams are not involved there.

### Single

Route all requests to one target:

```yaml
strategy:
  mode: single
  targets: ["openai-main"]
```

### Fallback

Try targets in order. On failure (5xx, 408, 429, network error, open circuit breaker) try the next. Upstream **401/403** (the target's credential is revoked or not entitled) and **404** (model/deployment missing at that target) also fail over; 401/403 additionally count as circuit-breaker failures, 404 does not. Caller-caused 4xx (400, 409, 413, 422, ...) fail immediately without failover or breaker impact. Each target can have retry with exponential backoff.

```yaml
strategy:
  mode: fallback
  targets: ["openai-main", "deepseek-backup", "groq-backup"]
targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    models: ["gpt-4o"]
    retry:
      attempts: 3
      initialBackoffMs: 100
  - name: deepseek-backup
    provider: deepseek
    apiKey: "sk-..."
    models: ["deepseek-chat"]
  - name: groq-backup
    provider: groq
    apiKey: "sk-..."
    models: ["llama-3"]
```

### Load Balance

Distribute requests across targets by weight (weighted random; the remaining
targets follow in weighted order as failover candidates). A weight of `0`
drains a target: it receives no traffic, not even as a failover candidate.
At least one weight must be greater than 0. Weights come from
`targets[].weight`, then `strategy.weights`, default 1.

```yaml
strategy:
  mode: loadbalance
  targets: ["openai-main", "deepseek-alt"]
  weights:
    openai-main: 3
    deepseek-alt: 1
```

### Conditional

Route on request fields. Rules are checked in order and the first match wins;
when nothing matches, the first entry of `strategy.targets` is the default
target (and also the failover target for a matched rule). Each rule has a
`field` and exactly one of `pattern` (regex, validated at startup) or
`contains` (case-insensitive substring):

| `field`   | Matched against                                   |
| --------- | ------------------------------------------------- |
| `model`   | the requested model                               |
| `user`    | the request's `user` field                        |
| `message` | the text of the first message                     |
| `prompt`  | the text of every user message (newline-joined)   |

```yaml
strategy:
  mode: conditional
  rules:
    - field: "model"
      pattern: "^gpt-4"
      target: "openai-main"
    - field: "prompt"
      contains: "translate"
      target: "deepseek-main"
  targets: ["openai-main"]  # default target
```

### Removed strategies (0.2.0)

These modes now fail `ai-gateway validate` and startup with a migration hint:

| Removed                                         | Use instead                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `least_latency`                                 | `fallback` with targets in order of preference                              |
| `cost_optimized` (+ `unpricedStrategy`)         | `fallback` with targets ordered from cheapest to most expensive             |
| `content_based` (+ `keywords`, `contentConditions`) | `conditional` with `field: prompt` rules (`contains` or `pattern`)      |
| `abtest` (+ `abVariants`)                       | `loadbalance` with `weights`. `abtest` still works as a deprecated alias of `loadbalance` (warning at startup) and will be removed in 0.3.0 |
| `strategy.conditions` (Go `key/value/target_key`) | `strategy.rules: [{ field, pattern, target }]`                            |

---

## Resilience

### Retry with Exponential Backoff

Configure per-target retry behavior (applies to every strategy, `single` included). Backoff uses exponential jitter: `delay = random(0, initialBackoffMs × 2^(attempt-1))`.

```yaml
targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    retry:
      attempts: 3
      initialBackoffMs: 100
      onStatusCodes: [408, 429, 500, 502, 503, 504]  # Default
```

A target without a `retry` block gets one attempt. With the block, `attempts` defaults to 3.

- **4xx errors (except 429)** are never retried on the same target. 401/403/404 still fail over to the next target (see Fallback); other 4xx indicate a client problem
- **408, 429 and 5xx** in `onStatusCodes` are retried with backoff
- **Network errors** are retried
- **AbortSignal** cancellation is respected immediately

### Circuit Breaker

Per-target circuit breaker prevents cascading failures:

```yaml
targets:
  - name: flaky-provider
    provider: openai
    apiKey: "sk-..."
    circuitBreaker:
      failureThreshold: 5       # Consecutive failures before opening (default: 5)
      successThreshold: 1       # Successes in half-open to close (default: 1)
      timeoutMs: 30000          # Time before half-open probe (default: 30000)
```

**State machine:**

```
CLOSED ──── failureThreshold failures ────→ OPEN
  ↑                                            │
  │                                  timeoutMs expires
  │                                            ↓
  └──── successThreshold successes ──── HALF_OPEN
                                             │
                                    probe fails → OPEN
```

- **CLOSED**: All requests pass through. Consecutive failures are counted.
- **OPEN**: The target is skipped (failover moves to the next candidate); when every candidate is open the request gets 503 `circuit_open` with `Retry-After`.
- **HALF_OPEN**: Up to `maxHalfThreshold` (default 1) probe requests allowed. `successThreshold` successes close the breaker, a failure reopens it.
- Settlement is permit-based: an outcome only counts in the breaker generation its request was admitted in. Client aborts and requests that never left the concurrency queue do not count.

### Concurrency Limit

```yaml
targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    concurrency:
      maxConcurrency: 20   # in-flight upstream calls for this target
      queueSize: 1000      # waiting requests (default 1000)
```

Off unless `maxConcurrency` is set. A request waits in the target's queue for a slot; when the queue is full, or the request deadline fires while it waits, that candidate fails with 429 `gateway_overloaded` (failover to the next candidate still applies) and the breaker is not charged.

---

## Plugins

Plugins run at three stages of the request lifecycle:

1. **`before_request`** — Modify or reject requests before they reach the provider
2. **`after_request`** — Inspect or modify responses after the provider returns
3. **`on_error`** — Handle errors from the provider

### Built-in Plugins

#### Rate Limit

Per-API-key request limits using fixed-window counters (O(1) memory and CPU per key; idle keys are evicted).

```yaml
plugins:
  - name: rate-limit
    stage: before_request
    config:
      maxRequestsPerMinute: 60  # Required (aliases: keyRpm, rpm)
      maxRequestsPerDay: 5000   # Optional (alias: rpd); no day window is tracked when unset
      key: shared               # Optional bucket name for requests without an API key (default: "default")
```

Windows start at a key's first request and reset after 60 s / 24 h, so a burst straddling a window boundary can admit up to twice the limit. Limits are per process (not shared between replicas). Rejections answer 429 `plugin_rejected` with `Retry-After` (seconds until the window resets). The `budget` plugin also answers 429.

#### Response Cache

LRU cache keyed on all meaningful request parameters (model, messages, temperature, tools, seed, maxTokens, etc.).

```yaml
plugins:
  - name: cache
    stage: before_request
    config:
      maxAge: 300               # Cache TTL in seconds (default: 300)
      maxEntries: 1000          # Max cached responses (default: 1000)
```

#### Word Filter

Content guardrail that rejects (or redacts) requests containing blocked words.

```yaml
plugins:
  - name: word-filter
    stage: before_request
    config:
      blockedWords: ["forbidden", "harmful"]   # alias: blocklist; empty list = plugin skipped
      mode: reject                             # reject (default, 403 plugin_rejected) | redact
```

Matching is case-insensitive on Unicode NFKC-normalized text, so compatibility look-alikes (Kelvin sign `K`, fullwidth `ｋｉｌｌ`, long `ſ`) are caught. In `mode: redact` the matched words become `***` (the affected text is forwarded in NFKC form); if a word is detected but cannot be redacted, the request is rejected. It is a coarse substring filter: zero-width characters and homoglyphs from other scripts still bypass it.

#### PII & Secret Guard

Guardrail that detects personal data and credentials and **blocks**, **redacts** or **logs** them.

```yaml
plugins:
  - name: pii-secret-guard
    stage: before_request
    type: guardrail
    config:
      action: block                 # default for every detection: block | redact | log (default: block)
      categories:                   # optional, overrides `action` per category
        secret: block
        pii: redact
      entityActions:                # optional, overrides category/default; naming an entity also enables it
        ipv4: log
        phone: log
      # entities: [email, phone, credit_card]   # optional: scan only these built-ins (default: all except ipv4)
      allowlist: ["@example\\.com$"] # regexes tested against each matched VALUE; a match is ignored
      patterns:                     # optional operator-defined detectors
        - { name: employee_id, pattern: "EMP-\\d{6}", category: pii, action: redact }
      surfaces: [chat, completions, embeddings, passthrough]   # default: all four
      roles: [system, user, assistant, tool, developer]        # default: all
      direction: request            # request (default) | response | both
      scanToolArguments: true       # scan assistant tool-call arguments (default: true)
      entropyThreshold: 3.5         # bits/char for generic `api_key=` / `password=` values (default: 3.5)
```

| Category | Entities |
| --- | --- |
| `secret` | `private_key` (PEM blocks), `anthropic_key` (`sk-ant-…`), `openai_key` (`sk-…`, also DeepSeek and other OpenAI-compatible keys), `aws_access_key` (`AKIA`/`ASIA`), `aws_secret_key` (in an `aws…secret… =` assignment), `github_token` (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`), `slack_token` (`xox*-`, `xapp-`), `google_api_key` (`AIza…`), `stripe_key` (`sk_/rk_` `live/test`), `jwt`, `generic_secret` (`api_key=` / `password:` / `client_secret=` … with a value above `entropyThreshold`) |
| `pii` | `email`, `phone` (CN mobile `1[3-9]x` with optional `+86`, E.164, formatted international, US), `cn_id` (18-digit PRC ID, GB 11643 check digit + valid date), `credit_card` (Luhn + issuer prefix), `iban` (mod-97), `ssn` (US, `123-45-6789` form), `ipv4` (opt-in) |

- **What is scanned:** every message whose role is in `roles` — string content, every text content part and, unless `scanToolArguments: false`, assistant tool-call arguments. `/v1/completions` `prompt` and `/v1/embeddings` `input` are scanned as user messages; pass-through routes scan the text the proxy extracts (`messages` / `input` / `prompt` / `instructions`). Text is compared in Unicode NFKC form (like word-filter) with zero-width and bidi-control characters removed, so fullwidth digits and `s\u200Bk-…` are caught. Validators (Luhn, ID check digit, IBAN mod-97, JWT header, entropy) cut false positives; when two findings overlap the more specific one wins (`api_key=sk-…` is an `openai_key`).
- **block** answers `400` with `code: "secret_detected"` or `"pii_detected"` (`type: "invalid_request_error"`); the message names entity types only and never echoes the value. Any block in a request wins over redact/log.
- **redact** replaces the value with a typed placeholder — `[EMAIL]`, `[PHONE]`, `[CN_ID]`, `[CREDIT_CARD]`, `[SECRET:github_token]`, `[CUSTOM:employee_id]` — and forwards the text in NFKC form. Tool-call arguments stay valid JSON (if a redaction would break them the request is blocked). Pass-through routes cannot forward a rewritten body, so there a redact detection is **blocked** instead.
- **log** forwards the request unchanged and records the detection.
- **Responses** (`direction: response | both`): non-streaming chat and completions responses are scanned (message content and tool-call arguments); block answers `422` with the same codes, redact rewrites the response the client receives. **Streaming responses are not scanned**: a block decided after chunks reached the client cannot be undone, and safe chunk-boundary scanning would mean holding back output. Request scanning applies to streaming requests as usual. List this plugin before `cache` so a redacted response is what gets cached.
- **Observability:** the request log gets `guardrail: [{plugin, direction, action, entities}]` (entity types only, never matched text); `ai_gateway_guardrail_detections_total{entity,category,action,direction}` counts detections; blocks increment `ai_gateway_plugin_blocked_total` (`outcome="plugin_rejected"` for requests, `"response_rejected"` for responses).
- The config has a strict schema: unknown keys, entities, actions, surfaces, roles or invalid regexes fail `ai-gateway validate` and startup.

Design adapted from ferro-labs/ai-gateway's `pii-redact` and `secret-scan` plugins (Apache-2.0); see NOTICE.

#### Max Token

Caps the output-token limit of each request.

```yaml
plugins:
  - name: max-token
    stage: before_request
    config:
      maxTokens: 4096           # Required. Caps max_tokens / max_completion_tokens; injected as max_tokens when the request sets neither
```

#### Budget

Per-API-key daily USD budget enforcement.

```yaml
plugins:
  - name: budget
    stage: before_request
    config:
      dailyBudget: 100          # Daily spend limit in USD
      costPer1kInput: 0.01     # Cost per 1K input tokens
      costPer1kOutput: 0.03    # Cost per 1K output tokens
      reserveOutputTokens: 1024 # optional: output tokens reserved when a request sets no max_tokens
```

Each request reserves its estimated cost (prompt ≈ 4 chars/token plus its
`max_tokens`, or `reserveOutputTokens`) before it is sent and is charged its
actual cost afterwards; the reservation is released however the request ends.
While other requests of the same key are in flight, a request is admitted only
if its estimate fits next to their reservations, so concurrency cannot
overshoot the budget. Without `costPer1kInput` / `costPer1kOutput` the
serving target's `costPer1kInputTokens` / `costPer1kOutputTokens` are used;
a budget with no rates anywhere is a config error (it would never enforce).

#### Logger (removed in 0.2.0)

The `logger` plugin duplicated the gateway's own request log (one JSON line
per request, see [Structured Logging](#structured-logging)). A `logger` entry
in `plugins` is ignored with a startup warning; remove it.

### Plugin Config and Error Policy

- Entries run in the order listed. `stage` is required by the schema, but each built-in registers itself on the stages it needs: `cache` and `budget` on both `before_request` and `after_request`, `pii-secret-guard` per its `direction`, the others on `before_request`. `type` is optional and informational. `enabled: false` skips an entry; names may use `_` instead of `-`. An unknown plugin name is ignored with a warning.
- **Errors are fail-closed for every plugin:** a plugin that throws fails the request (500 `Internal server error`, logged with the request). There is no fail-open mode.

---

## MCP (Model Context Protocol)

The gateway supports external MCP tool servers. When configured, the gateway:

1. Discovers tools from MCP servers on startup
2. Injects tool definitions into chat completion requests
3. Executes an agentic loop when the LLM returns `tool_calls`
4. Re-invokes the LLM with tool results until no more tool calls or max depth reached

```yaml
mcpServers:
  - name: filesystem
    type: stdio
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

Only the stdio transport is supported. `type: http` / `url` / `headers` (never
implemented) were removed from the schema in 0.2.0 and fail validation.

**Agentic loop:**

```
User request → LLM returns tool_calls → Gateway executes tools via MCP
  → Tool results appended to messages → LLM called again
  → Repeat until no tool_calls or depth limit (default: 5)
  → Final response returned to user
```

- Per-server options: `timeoutSeconds` per tool call (default 30), `maxCallDepth` (default 5, read from the first `mcpServers` entry and applied to the whole loop; exceeding it answers 502 `mcp_depth_exceeded`), `allowedTools` (expose only these tools), `required` (gates `/readyz` / `/livez`, see below)
- **Crash recovery:** if a stdio server fails to start or its process exits, the gateway reconnects it in the background with exponential backoff (1 s, 2 s, 4 s, … capped at 60 s) and logs every disconnect, failed attempt and recovery (`[mcp] server "name" ...`). Its tools are unavailable while it is down (and `/readyz` is 503 if it is `required`). After 5 consecutive failed attempts of a `required` server, `/livez` returns 503 so Kubernetes restarts the pod instead of keeping a never-ready replica.
- **Environment:** stdio servers do **not** inherit the gateway's environment. They get only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TZ`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TMPDIR` (plus the Windows basics `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`) and the server's own `env` map, so provider API keys, `ADMIN_BOOTSTRAP_KEY`, OTLP tokens and cloud credentials never reach third-party MCP packages. Pass what a server needs in `env`, list extra variable names with `inheritEnv: ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]`, or opt back into full inheritance with `inheritEnv: true` (not recommended).
- MCP tools are injected into **non-streaming** requests only. Streaming requests (`stream: true`) are forwarded without MCP tools and no agentic loop runs, so a streaming client never receives tool_calls for gateway-side tools it did not declare. Use a non-streaming request when you want the gateway to run MCP tools.

---

## Observability

### OpenTelemetry Tracing

```yaml
observability:
  tracing:
    enabled: true
    otlpEndpoint: "http://localhost:4318/v1/traces"   # or env OTEL_EXPORTER_OTLP_ENDPOINT
    serviceName: "ai-gateway"
    sampleRatio: 1.0          # or env OTEL_TRACES_SAMPLER
    privacyLevel: metadata    # none | metadata | full
    headers: {}               # e.g. auth headers for the collector (scrubbed in /admin/config)
    shutdownGrace: "10s"      # flush budget on shutdown
```

Spans are exported over **OTLP/HTTP** to `otlpEndpoint` as given (use the full `/v1/traces` URL). `otlpProtocol: grpc | http` is accepted by the schema but has no effect: only the HTTP exporter is implemented. Tracing stays off without `enabled: true` and an endpoint.

One root span per request (`request.model` attribute; errors recorded on it):

- `gateway.route` (non-streaming chat), `gateway.routeStream` (streaming chat)
- `gateway.completions`, `gateway.completions_stream`, `gateway.embedding`, `gateway.image`, `gateway.passthrough`

There are no per-plugin or per-MCP-call child spans.

### Prometheus Metrics

`GET /metrics` (no auth) is served on the main port unless configured otherwise:

```yaml
observability:
  metrics:
    enabled: true   # false: /metrics is not served at all
    port: 9090      # optional; a port other than server.port gets its own listener
```

Without an `observability.metrics` block, `/metrics` stays on the main port.

| Metric                           | Type      | Labels              |
| -------------------------------- | --------- | ------------------- |
| `ai_gateway_requests_total`      | counter   | `method`, `status`, `provider` |
| `ai_gateway_request_duration_seconds` | histogram | `method`, `status`, `provider` |
| `ai_gateway_tokens_input_total`  | counter   | `provider`, `model` |
| `ai_gateway_tokens_output_total` | counter   | `provider`, `model` |
| `ai_gateway_request_cost_usd`    | counter   | `provider`, `model` (targets with `costPer1k*Tokens`) |
| `ai_gateway_provider_errors_total` | counter | `provider`, `error_type` (every failed upstream attempt, including ones that failed over) |
| `ai_gateway_circuit_breaker_state` | gauge   | `provider`, `state` (1 = current state) |
| `ai_gateway_mcp_server_up`       | gauge     | `server` |
| `ai_gateway_rate_limit_rejections_total` | counter | `provider` (`none`: rejections by the `rate-limit` plugin) |
| `ai_gateway_plugin_blocked_total` | counter  | `plugin`, `outcome` (`plugin_rejected`, `plugin_short_circuit`, `response_rejected`), `surface` |
| `ai_gateway_guardrail_detections_total` | counter | `entity`, `category`, `action`, `direction` |

### Structured Logging

Every request is logged exactly once as structured JSON to stdout (and to the request-log store behind `GET /admin/logs` and the dashboard):

```json
{
  "timestamp": "2026-07-27T00:00:00.000Z",
  "requestId": "abc-123",
  "model": "gpt-4o",
  "provider": "openai-main",
  "strategy": "single",
  "durationMs": 1500,
  "surface": "chat",
  "tokens": {"prompt": 15, "completion": 8, "total": 23},
  "status": 200
}
```

Optional fields: `error`, `usageEstimated` (stream without a usage chunk), `plugin` / `outcome` (request ended by a plugin), `guardrail` (detections, entity types only). `surface` is `chat`, `chat_stream`, `completions`, `completions_stream`, `embedding`, `image` or `passthrough`.

---

## Security

### Authentication

Configure API key authentication:

```yaml
auth:
  enabled: true
  keys:
    - "sk-my-first-key"
    - "sk-my-second-key"
```

Clients must send `Authorization: Bearer <key>`. Paths `/health`, `/livez`, `/readyz`, `/metrics`, and `/admin/*` skip auth.

Client auth is **on unless `auth.enabled: false` is set explicitly** (omitting `auth` or `enabled` keeps it on), and it is enforced the same way by `bun src/index.ts serve`, the `ai-gateway serve` CLI (which runs the same bootstrap, including the API key store) and embedded `createApp(gateway, config)`. Accepted credentials are `auth.keys` and, when a key store is passed, its keys. With auth on and no credentials at all, every `/v1/*` request gets 401 (fail closed) and a warning is printed at startup.

API key comparison uses constant-time equality to prevent timing attacks.

### Admin Authentication

`/admin/*` uses its own auth (client auth skips it):

```yaml
adminSecret: "a-long-random-secret-at-least-8-chars"   # optional; 16+ chars in production
```

Send the secret via `X-Admin-Secret` or `Authorization: Bearer <secret>`. With the key store (`ai-gateway serve`), `admin` / `read_only` store keys work too, so `adminSecret` is optional; without a key store and without `adminSecret` the admin API is disabled (403). See [Admin API](#admin-api) and [Key scopes](#key-scopes-key-store-mode).

### Body Size Limit

```yaml
maxRequestBytes: 10485760  # 10 MB (default)
```

Both the `Content-Length` header and actual body size are enforced.

### Security Headers

All responses include:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 0
Referrer-Policy: strict-origin-when-cross-origin
```

### CORS

```yaml
cors:
  enabled: true
  origins:
    - "https://my-app.example.com"
  # allowHeaders: ["Content-Type", "Authorization"]  # optional; default reflects
  #   the browser's Access-Control-Request-Headers (needed for SDK headers such as
  #   x-stainless-*, openai-organization, openai-project)
```

### Request Timeout

```yaml
requestTimeout: "30s"  # default 30s; also 5m, 1h
```

Sets an `AbortController` that aborts the upstream fetch if exceeded (504 `gateway_timeout`). It covers the request until a streaming response starts; streams are then bounded by `server.streamIdleTimeoutSeconds` / `streamMaxDurationSeconds`.

---

## Model Aliases

Map friendly names to actual model IDs:

```yaml
aliases:
  fast: "gpt-4o-mini"
  smart: "gpt-4o"
  cheap: "deepseek-chat"
```

Clients can then use `"model": "fast"` and the gateway resolves it to `"gpt-4o-mini"`.

---

## Compatibility Mode

Different providers support different OpenAI parameters. The compatibility mode controls what happens when a client sends a parameter the provider doesn't support:

```yaml
compatibility:
  onUnsupportedParam: warn  # warn | drop | reject
```

- **`warn`** (default): log a warning and send the request unchanged
- **`drop`**: remove the unsupported parameters before sending (a `developer` message becomes `system` for providers without the developer role; image parts are kept, with a warning)
- **`reject`**: return a 400 naming the unsupported parameters (wire names, e.g. `seed`, `stream_options`)

The check uses the target's `provider` (e.g. `mistral`, `ollama`, `replicate`, `cloudflare`, `huggingface` have reduced parameter sets); providers not in the matrix are assumed to support everything.

---

## Embedded Mode

Use the gateway as a library in your own application:

```typescript
import { Gateway, createApp, loadConfigFromPath } from "ai-gateway-rewrite";

// Load config
const config = loadConfigFromPath("./config.yaml");

// Create gateway
const gateway = new Gateway(config);
await gateway.initMcp();

// Use programmatically
const response = await gateway.route(
  { metadata: {} },
  { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] }
);

// Or create an HTTP app
const app = createApp(gateway, config);
// Use with any Hono-compatible server.
// Client auth applies here too: /v1/* requires a Bearer key from auth.keys
// (401 for everything if auth is on and auth.keys is empty). Set
// auth.enabled: false explicitly for an unauthenticated in-process app.

// Clean up
gateway.close();
```

### Gateway API

| Method                               | Description                                |
| ------------------------------------ | ------------------------------------------ |
| `route(ctx, req)`                    | Non-streaming chat completion              |
| `routeStream(ctx, req)`              | Streaming chat completion (AsyncGenerator) |
| `execute(surface, req, ctx)`         | Any surface (`core/surfaces/*`) through the pipeline |
| `executeStream(surface, req, ctx)`   | Chat-shaped surface (chat, completions) streamed |
| `embed(ctx, req)`                    | Embedding generation                       |
| `embedWithPlugins(ctx, req)`         | Embedding with plugin lifecycle            |
| `generateImage(ctx, req)`            | Image generation                           |
| `generateImageWithPlugins(ctx, req)` | Image generation with plugin lifecycle     |
| `listModels()`                       | List all models                            |
| `registerProvider(provider)`         | Add a provider at runtime                  |
| `registerPlugin(stage, plugin)`      | Add a plugin at runtime                    |
| `getConfig()`                        | Get current config (read-only)             |
| `initMcp()`                          | Connect the configured MCP servers         |
| `addRequestLogSink(sink)`            | Receive every finalized request-log entry  |
| `close()`                            | Graceful shutdown                          |

---

## Architecture

```
                         ┌──────────────────────────────────────────────┐
  CLI  (src/cli)         │ server/bootstrap.ts                          │
  serve | validate |     │  load + strictly validate config (file only) │
  keys  | version  ────▶ │  open SQLite stores, production-safety check │
                         │  new Gateway(config), MCP connect, OTel      │
                         │  Bun.serve(createApp(...)), shutdown/drain   │
                         └──────────────────────┬───────────────────────┘
                                                │
┌───────────────────────────────────────────────▼──────────────────────────────┐
│ HTTP layer: app.ts (Hono)                                                     │
│  recover → body-limit → security-headers → CORS → request metrics             │
│  → drain gate (503 while shutting down) → client auth (skips probes, /metrics,│
│    /admin/*) → per-IP limit (/v1/*, off by default) → request timeout         │
│                                                                               │
│  handlers/      Zod validation, OpenAI wire ⇄ internal types (openai-wire),   │
│                 SSE writer, OpenAI-shaped errors                              │
│  proxy/         opt-in allow-listed pass-through for other /v1/* routes       │
│  admin/         /admin/* API (admin auth: adminSecret, admin / read_only keys)│
│  dashboard/     /admin/dashboard console (static shell + console.js)          │
└───────────────────────────────────────────────┬──────────────────────────────┘
                                                │ gateway.ts facade
                                                │ execute(surface) / executeStream(surface)
┌───────────────────────────────────────────────▼──────────────────────────────┐
│ core/                                                                         │
│  surfaces/{chat, completions, embeddings, images, passthrough}               │
│      per-endpoint glue: model, plugin view, call, usage, short-circuit       │
│  pipeline.ts      alias → before plugins → executor → (MCP loop) → finalize  │
│  chat-stream.ts + stream-runner.ts   streaming variant, finalize once/stream │
│  mcp-loop.ts      MCP agentic tool loop (non-streaming chat-shaped requests) │
│  executor.ts      candidates → breaker permit → limiter → call → retry →     │
│                   classify (outcome.ts) → fail over / stop                   │
│  errors.ts        one GatewayError model, "most meaningful" error pick       │
│  assembly.ts      config → registry, plugins, strategy, breakers, limiters   │
└──────┬──────────────────────────┬─────────────────────────────┬──────────────┘
       │                          │                             │
┌──────▼──────────────┐  ┌────────▼───────────────────┐  ┌──────▼───────────────┐
│ plugins/            │  │ routing/                   │  │ providers/           │
│  manager (3 stages) │  │  strategies only ORDER     │  │  openai-compat.ts:   │
│  builtins: rate-    │  │  targets: single, fallback,│  │  one adapter for all │
│  limit, cache,      │  │  loadbalance, conditional  │  │  22 presets          │
│  word-filter, max-  │  │  circuit-breaker (permits),│  │  (core/provider-     │
│  token, budget,     │  │  concurrency-limiter queue,│  │  presets.ts),        │
│  pii-secret-guard   │  │  retry (exp. jitter)       │  │  wire-extras,        │
└─────────────────────┘  └────────────────────────────┘  │  sse-parser,         │
                                                         │  capabilities        │
                                                         └──────────┬───────────┘
                                                                    │ fetch
                                                             upstream LLM APIs

 Cross-cutting: config/ (Zod schema, AI_GATEWAY_* overrides, removed-key hints)
                persistence/ (SQLite: key-store [WAL, bootstrap latch], request-log-store, migrations)
                auth/ (bootstrap-key gate, key hashing)   mcp/ (stdio client, registry, executor)
                observability/ (OTel tracing, request log, redaction)   metrics/ (Prometheus)
```

### Request Flow

Non-streaming `POST /v1/chat/completions` (the other surfaces follow the same
pipeline; embeddings and images skip the MCP loop):

```
Client
  │
  ├─ Middleware: recover, body-limit, security headers, CORS, metrics,
  │   drain gate, client auth (scopes inference / read_only / admin all
  │   accepted on /v1/*), per-IP limit (if configured), request timeout
  │
  ├─ handlers/chat.ts: parse JSON, Zod-validate, wire → internal request
  │
  ├─ gateway.execute(chatSurface)  →  core/pipeline.ts
  │   │
  │   ├─ 1 alias resolution (aliases)
  │   ├─ 2 before plugins, in config order: rate-limit, word-filter,
  │   │     max-token, pii-secret-guard, cache lookup, budget reserve ...
  │   │     reject → finalize → error;  short-circuit (cache hit) → finalize → 200
  │   ├─ 3 plugin view written back; MCP tools injected (chat, non-stream)
  │   ├─ 4 strategy.selectTargets() → ordered candidate targets
  │   ├─ 5 core/executor.ts, per candidate:
  │   │     breaker.acquire() (open → skip, 503 circuit_open if all open)
  │   │     → limiter.acquire(signal) (queue full / deadline → 429 gateway_overloaded)
  │   │     → provider call, wrapped in per-target retry
  │   │     → classify outcome (core/outcome.ts) → settle breaker permit
  │   │     → failover-eligible (network, 5xx, 408, 429, 401/403/404)? next candidate
  │   │       caller 4xx / client abort / gateway timeout? stop
  │   ├─ 6 MCP loop: gateway-owned tool_calls → call tools → step 5 again
  │   │     (until no tool_calls or maxCallDepth; usage summed)
  │   └─ 7 finalize, exactly once: after / on_error plugins (cache store,
  │         budget charge, response guard) → settle callbacks (budget
  │         release) → request log (stdout + SQLite) → metrics → span end
  │
  └─ handlers: internal response → OpenAI wire JSON (+ X-Gateway-* headers)
```

Streaming (`stream: true`, chat and completions) goes through
`gateway.executeStream()` → `core/chat-stream.ts` and `core/stream-runner.ts`:
same before plugins and candidates; failures before the first chunk fail over
like step 5, after it the target is fixed. The stream ends as `done`,
`truncated`, `upstream_error`, `idle_timeout` or `client_cancel`; finalize runs
once for every end (usage estimated when the upstream sent none). `data: [DONE]`
is written only for a stream that completed; any other end sends an SSE error
event without `[DONE]`. MCP tools are not injected into streams.

Pass-through (`passthroughProxy.enabled`): allow-list check → before plugins
(`core/surfaces/passthrough.ts`) → `proxy/proxy.ts` forwards verbatim; no
breaker, failover, after plugins or budget accrual.

### Project Structure

```
src/
├── index.ts                 # Package entry (embedded exports); runs the CLI when executed
├── gateway.ts               # Gateway facade: execute / executeStream, route, embed, MCP, stores
├── app.ts                   # Hono app: middleware order, handlers, proxy, admin, /metrics
├── version.ts               # VERSION
│
├── cli/
│   ├── index.ts             # serve | validate | keys | version (raw argv parsing)
│   └── keys.ts              # keys create | list | revoke on the SQLite key store
├── server/
│   ├── bootstrap.ts         # One server start path: stores, safety checks, OTel, listeners
│   ├── shutdown.ts          # SIGTERM/SIGINT drain, in-flight tracker, grace + force close
│   └── route-path.ts        # Path normalization (//, trailing /, %2F, case)
│
├── config/
│   ├── schema.ts            # Strict Zod schema (unknown keys are errors, with hints)
│   ├── loader.ts            # YAML/JSON file + AI_GATEWAY_* overrides, validateConfig()
│   ├── validate.ts          # Cross-reference checks (target names, rules, base URLs)
│   ├── removed.ts           # Keys/modes removed in 0.2.0 with migration hints
│   ├── production-safety.ts # GATEWAY_ENV=production startup guard
│   ├── envref.ts            # ${VAR} expansion
│   └── types.ts
│
├── middleware/
│   ├── recover.ts  body-limit.ts  security-headers.ts  cors.ts
│   ├── auth.ts              # Client auth + admin auth (timing-safe, scopes)
│   ├── per-ip-rate-limit.ts # Token bucket per client IP (off by default)
│   ├── trusted-proxy.ts     # TRUSTED_PROXIES / X-Forwarded-For resolution
│   └── request-timeout.ts   # AbortController deadline (default 30s)
│
├── handlers/
│   ├── chat.ts  completions.ts  embeddings.ts  images.ts   # POST /v1/*
│   ├── models.ts  capabilities.ts  health.ts               # GET /v1/models, /v1/capabilities, /health /livez /readyz
│   ├── request.ts           # RequestContext, abort-signal linking
│   ├── openai-wire.ts       # snake_case wire ⇄ camelCase internal types
│   ├── error-response.ts    # OpenAI-shaped error responses
│   ├── sse-stream.ts  sse-heartbeat.ts  abort.ts
│
├── core/
│   ├── pipeline.ts          # execute(surface, req, ctx): steps 1–7, finalize once
│   ├── chat-stream.ts       # executeStream for chat / completions
│   ├── stream-runner.ts     # First chunk + failover, stream end kinds, SSE writer
│   ├── executor.ts          # Candidate executor: breaker → limiter → call → retry → failover
│   ├── outcome.ts           # Attempt classification (breaker settlement, failover eligibility)
│   ├── errors.ts            # GatewayError, OpenAI error shape, mostMeaningful()
│   ├── mcp-loop.ts          # MCP agentic loop (usage summed)
│   ├── mcp-runtime.ts       # MCP connect / readiness
│   ├── assembly.ts          # Config → registry, plugins, strategy, breakers, limiters, pipeline
│   ├── strategy-config.ts   # config.strategy → mode + per-mode config
│   ├── provider-presets.ts  # The 22 provider presets (base URLs, aliases, extras)
│   ├── usage.ts             # Usage sums, stream estimate, costOf
│   ├── types.ts             # Surface, RequestRun, FinalizeOutcome, StreamEnd
│   └── surfaces/            # chat, completions, embeddings, images, passthrough
│
├── routing/
│   ├── types.ts             # IStrategy { mode, selectTargets }
│   ├── strategy-factory.ts
│   ├── single.ts  fallback.ts  loadbalance.ts  conditional.ts
│   ├── circuit-breaker.ts   # Permit-based state machine + registry
│   ├── concurrency-limiter.ts # Per-target slots, abortable queue
│   ├── retry.ts             # Exponential backoff with jitter
│   └── outcome.ts           # Re-export of core/outcome.ts
│
├── providers/
│   ├── openai-compat.ts     # The one OpenAI-compatible adapter
│   ├── wire-extras.ts       # Allow-listed pass-through fields
│   ├── sse-parser.ts        # Upstream SSE parser (4 MiB event cap)
│   ├── capabilities.ts      # Per-provider parameter matrix (compatibility mode)
│   ├── response-headers.ts  # Forwarded upstream headers
│   └── registry.ts  types.ts  index.ts
│
├── plugins/
│   ├── manager.ts  context.ts  error.ts  types.ts
│   └── builtins/            # 6 built-ins + from-config.ts
│       ├── rate-limit.ts  cache.ts  word-filter.ts  max-token.ts  budget.ts
│       └── pii-secret-guard/   # config, detectors, validators, plugin
│
├── mcp/                     # stdio client (MCP 2025-03-26 subset), registry, executor
├── proxy/proxy.ts           # Pass-through proxy for allow-listed /v1/* routes
├── persistence/
│   ├── key-store.ts         # API keys (SHA-256), scopes, WAL, bootstrap latch
│   ├── request-log-store.ts # /admin/logs storage
│   └── migrations.ts        # Versioned SQLite migrations
├── auth/                    # bootstrap.ts (bootstrap-key gate), key-hash.ts
├── admin/                   # /admin/* API: config (read-only), keys, logs, status, scrubbing
├── dashboard/               # Console page shells + static/console.{js,css} (embedded)
├── observability/           # OTel SDK + tracer bridge, sampling/privacy, request log, redaction
├── metrics/metrics.ts       # Prometheus registry (prom-client)
└── types/assets.d.ts

tests/
├── unit/                    # Per-module tests
├── integration/             # Full request flows in-process
├── regressions/             # Imported bug-hunt repros, now regression tests
├── types/                   # Type declarations used by tests
└── e2e/                     # Real server + mock upstream + openai SDK (bun run test:e2e)
scripts/                     # docker-smoke.sh, binary-smoke.sh, build-binaries.sh, release-notes.sh
```

---

## Development

### Scripts

```bash
bun run dev              # Start with file watching (bun run --watch src/index.ts)
bun run start            # Start without watching
bun run test             # Unit + integration + regression tests (bun test)
bun run test:e2e         # E2E contract tests: real server, mock upstream, openai SDK
bun run test:watch       # Run tests in watch mode
bun run typecheck        # Type-check src with tsc
bun run typecheck:tests  # Type-check tests
bun run lint             # biome ci .
bun run lint:fix         # biome lint --write .
```

### Running Tests

```bash
# All tests (unit + integration + regressions)
bun test

# E2E suite (CI runs both)
bun run test:e2e

# Specific test file
bun test tests/unit/routing/fallback.test.ts

# Watch mode
bun run test:watch
```

---

## Migration from Go ai-gateway

| Go Feature                                    | TypeScript Equivalent                  |
| --------------------------------------------- | -------------------------------------- |
| `ferrogw serve`                               | `ai-gateway serve -c config.yaml`      |
| 29 providers (incl. Anthropic/Gemini/Bedrock) | 20+ OpenAI-compatible providers        |
| Non-OpenAI-wire translation                   | Not supported (by design)              |
| Dashboard UI                                  | Minimal admin console (`/admin/dashboard`) |
| `NonOpenAIWireProvider` proxy rejection       | Generic fallback with `baseURL`        |
| `sync.Pool` context pooling                   | Standard JS patterns                   |
| `httputil.ReverseProxy` pass-through          | Opt-in allow-listed proxy (`passthroughProxy`) |
| Per-target concurrency limiter                | `targets[].concurrency` (`maxConcurrency`, `queueSize`) |
| 8 routing strategies                          | 4 (`single`, `fallback`, `loadbalance`, `conditional`); see [Removed strategies](#removed-strategies-020) |
| MCP stdio + HTTP                              | stdio only                             |
| Model catalog / discovery                     | Static config only                     |
| Config file watcher                           | Not supported: edit the file and restart |

## License

Apache License 2.0. See [LICENSE](LICENSE).

The design is derived from [Ferro Labs AI Gateway](https://github.com/ferro-labs/ai-gateway) (Apache-2.0); attribution is kept in [NOTICE](NOTICE).
