# AI Gateway

A high-performance OpenAI-compatible API gateway built with TypeScript, Bun, and Hono.

Route requests across 20+ LLM providers through a single unified endpoint, with 8 routing strategies, 6 built-in plugins, circuit breakers, retry with backoff, MCP agentic tool calling, and full observability.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) 1.3+

### Install & Run

```bash
git clone <repo-url> && cd ai-gateway-rewrite
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

---

## CLI Reference

```
ai-gateway <command> [options]

Commands:
  serve      Start the gateway server
  validate   Validate a config file
  version    Print version information

Options:
  -c, --config <path>   Path to config file (YAML or JSON)
  -h, --help            Show help
  -v, --version         Show version
```

### Examples

```bash
# Start serving
ai-gateway serve -c config.yaml

# Validate config without starting
ai-gateway validate -c config.yaml

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
  sseHeartbeatSeconds: 5    # SSE ": ping" comment while a stream is idle; 0 = off
  streamIdleTimeoutSeconds: 120  # end a stream when upstream sends nothing this long; 0 = off
  streamMaxDurationSeconds: 0    # hard cap on one stream's duration; 0 = off (default)

passthroughProxy:
  enabled: false            # forward other /v1/* routes upstream (see API Endpoints)

strategy:
  mode: single              # single | fallback | loadbalance | conditional |
                             # least_latency | cost_optimized | content_based | abtest
  targets: ["openai-main"]  # Target names for the strategy
  weights:                  # Per-target weights (loadbalance, abtest)
    openai-main: 3
    deepseek-backup: 1
  rules:                    # Conditional routing rules
    - field: "model"
      pattern: "^gpt-4"
      target: "openai-main"
  keywords:                 # Content-based routing keywords
    code: "openai-main"
    translate: "deepseek"

targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    baseURL: "https://api.openai.com/v1"   # Optional, has per-provider defaults
    models: ["gpt-4o", "gpt-4o-mini"]
    weight: 3                               # For loadbalance strategy
    costPer1kInputTokens: 0.005             # For cost_optimized strategy
    costPer1kOutputTokens: 0.015
    retry:                                  # Per-target retry config
      attempts: 3                           # Max attempts (default: 1 = no retry)
      initialBackoffMs: 100                 # Base backoff in ms (default: 100)
      onStatusCodes: [429, 500, 502, 503]  # Retryable status codes
    circuitBreaker:                         # Per-target circuit breaker
      failureThreshold: 5                   # Consecutive failures before open (default: 5)
      successThreshold: 1                   # Successes in half-open to close (default: 1)
      timeoutMs: 30000                      # Open → half-open timeout (default: 30000)

  - name: deepseek-backup
    provider: deepseek
    apiKey: "sk-..."
    models: ["deepseek-chat"]

auth:
  enabled: true
  keys:
    - "sk-my-api-key-1"
    - "sk-my-api-key-2"

adminSecret: "a-secure-admin-secret-at-least-8-chars"

cors:
  enabled: true
  origins:
    - "https://my-app.example.com"
    - "http://localhost:3000"

maxRequestBytes: 10485760       # 10 MB body limit (default)
requestTimeout: "30s"           # Go-style duration: 30s, 5m, 1h

aliases:
  fast: "gpt-4o-mini"
  smart: "gpt-4o"

plugins:
  - name: rate-limit
    stage: before_request
    config:
      requestsPerSecond: 100
      burst: 200
      keyRpm: 60
  - name: cache
    stage: before_request
    config:
      maxAge: 300
      maxEntries: 1000
  - name: word-filter
    stage: before_request
    config:
      blockedWords: ["forbidden", "blocked"]
      caseSensitive: false
  - name: max-token
    stage: before_request
    config:
      maxTokens: 4096
      maxMessages: 100
  - name: budget
    stage: before_request
    config:
      dailyBudget: 100
      costPer1kInput: 0.01
      costPer1kOutput: 0.03
  - name: logger
    stage: after_request

compatibility:
  onUnsupportedParam: warn      # warn | drop | reject

mcpServers:
  - name: my-tools
    type: stdio
    command: "node"
    args: ["my-mcp-server.js"]
  - name: remote-tools
    type: http
    url: "https://mcp.example.com/sse"
    headers:
      Authorization: "Bearer sk-..."

observability:
  tracing:
    enabled: true
    otlpEndpoint: "http://localhost:4318"
    otlpProtocol: http          # grpc | http
    serviceName: "ai-gateway"
  metrics:
    enabled: true
    port: 9090
```

### Environment Variable Overrides

Any config field can be overridden with `AI_GATEWAY_` prefix, using `_` as path separator:

```bash
AI_GATEWAY_SERVER_PORT=8080
AI_GATEWAY_AUTH_ENABLED=true
AI_GATEWAY_MAX_REQUEST_BYTES=20971520
```

String fields like `apiKey` and `adminSecret` are never auto-converted to numbers.

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
| `cloudflare`  | `https://api.cloudflare.com/client/v4/accounts`     |
| `databricks`  | `https://.databricks.com/serving-endpoints`         |
| `huggingface` | `https://api-inference.huggingface.co/v1`           |

Any unknown provider with an explicit `baseURL` is treated as a generic OpenAI-compatible endpoint.

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
  "provider": "openai-main",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello! How can I help?"},
    "finishReason": "stop"
  }],
  "usage": {"promptTokens": 15, "completionTokens": 8, "totalTokens": 23}
}
```

**Streaming response** (`"stream": true`):

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finishReason":""}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"!"},"finishReason":""}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finishReason":"stop"}],"usage":{"promptTokens":15,"completionTokens":2,"totalTokens":17}}

data: [DONE]
```

### Legacy Completions

```
POST /v1/completions
```

Compatible with the legacy `/v1/completions` endpoint. Prompts are converted to a single user message internally.

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

Any other `/v1/*` route (e.g. `/v1/responses`, `/v1/files`) returns **404**
unless the pass-through proxy is enabled:

```yaml
passthroughProxy:
  enabled: true   # default: false
```

When enabled, the request is forwarded verbatim to the target chosen by the
`X-Provider` header or the body's top-level `model`, after the
**before-request plugins** run on it (rate-limit, budget check, word-filter on
`messages` / `input` / `prompt` / `instructions`). Because the body shape is
unknown, a plugin that would rewrite content (word-filter `redact`) or
short-circuit causes a 403 instead. Proxied requests do **not** get circuit
breakers, fallback, after-request plugins or budget accrual, which is why the
proxy is off by default.

### Health Probes

| Endpoint      | Purpose                                      | Status Codes |
| ------------- | -------------------------------------------- | ------------ |
| `GET /health` | General health check                         | 200          |
| `GET /livez`  | Process liveness (Kubernetes liveness probe) | 200          |
| `GET /readyz` | Readiness: config + providers loaded, config store and required MCP servers up, not draining. Upstream circuit-breaker state does **not** affect readiness (every replica shares the same upstreams; failing readiness would pull the whole fleet); it is reported in the body as `circuitBreakers` / `upstreamAvailable`. Returns 503 immediately once SIGTERM/SIGINT drain starts, and new requests are refused with 503 during the drain | 200 / 503    |

### Metrics

```
GET /metrics
```

Prometheus-format metrics including:

- `ai_gateway_requests_total{provider, model}` — request counter
- `ai_gateway_tokens_input_total{provider, model}` — input token counter
- `ai_gateway_tokens_output_total{provider, model}` — output token counter
- `ai_gateway_request_duration_ms{provider, model}` — latency histogram

### Admin API

All admin endpoints require the `X-Admin-Secret` header (or `Authorization: Bearer <secret>`) matching the `adminSecret` config field. If no `adminSecret` is configured, admin endpoints return 403.

| Method | Path                   | Description                            |
| ------ | ---------------------- | -------------------------------------- |
| GET    | `/admin/config`        | Get current config (secrets redacted)  |
| GET    | `/admin/keys`          | List API keys (redacted)               |
| POST   | `/admin/keys`          | Add a new API key                      |
| DELETE | `/admin/keys/:id`      | Delete an API key by index             |
| GET    | `/admin/logs`          | View recent log entries                |

The config is read-only at runtime: there is no hot reload and no config write API (removed in 0.2.0; the old write routes answer `410 config_api_removed`). To change config, edit the file and restart (rolling restart behind a load balancer). `SIGHUP` is logged and ignored.

**Example:**

```bash
# Get config
curl -H "X-Admin-Secret: my-secret" http://localhost:3000/admin/config

# Add a key
curl -X POST \
  -H "X-Admin-Secret: my-secret" \
  -H "Content-Type: application/json" \
  -d '{"key": "sk-new-key"}' \
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

- the key store has a usable admin key (active, not revoked, not expired), e.g. after `POST /admin/keys {"name": "ops", "scopes": ["admin"]}`;
- `adminSecret` is configured;
- `auth.keys` are configured.

Inference-only or `read_only` store keys do not retire them (otherwise creating a client key first would lock you out of the admin API). The check runs on every request, so the bootstrap key stops working the moment the first admin key is created. Startup prints a warning while the bootstrap key is live, and the gateway logs `[auth] ADMIN_BOOTSTRAP_KEY / ADMIN_BOOTSTRAP_READ_ONLY_KEY disabled: <reason>` when it is refused (at startup or at runtime). Remove the variables from the environment once you have an admin credential. Without a key store (embedded `createApp(gateway, config)`) they are never accepted.

### Response Headers

The gateway adds these headers to responses:

| Header                   | Description                                   |
| ------------------------ | --------------------------------------------- |
| `X-Gateway-Provider`     | Name of the provider that handled the request |
| `X-Gateway-Overhead-Ms`  | Gateway processing time in milliseconds       |
| `X-Content-Type-Options` | `nosniff`                                     |
| `X-Frame-Options`        | `DENY`                                        |
| `Referrer-Policy`        | `strict-origin-when-cross-origin`             |

---

## Routing Strategies

Every multi-target strategy (fallback, loadbalance, least_latency,
cost_optimized, conditional, content_based, abtest) produces an **ordered
candidate list** (its preferred target first) and runs it through one shared
executor: a candidate whose circuit breaker is open, that hits its
concurrency limit, or that fails with a failover-eligible error (network,
5xx, 408, 429, 401/403/404) is skipped and the next candidate is tried, using
each target's own `retry` config. Caller-caused 4xx (400/409/413/422...),
client aborts and the gateway request timeout end the request. Streams fail
over only before their first chunk. Conditional / content_based fail over
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

Distribute requests across targets by weight:

```yaml
strategy:
  mode: loadbalance
  targets: ["openai-main", "deepseek-alt"]
  weights:
    openai-main: 3
    deepseek-alt: 1
```

### Conditional

Route based on request field matching (regex supported):

```yaml
strategy:
  mode: conditional
  rules:
    - field: "model"
      pattern: "^gpt-4"
      target: "openai-main"
    - field: "model"
      pattern: "^deepseek"
      target: "deepseek-main"
  targets: ["openai-main"]  # default target
```

### Least Latency

Route to the target with the lowest observed p50 latency. Targets with no
samples yet are tried first (so they get measured); a target that just failed
is ranked last for 30 s (or until it succeeds as a failover candidate):

```yaml
strategy:
  mode: least_latency
  targets: ["openai-main", "groq-fast", "cerebras-fast"]
```

### Cost Optimized

Route to the cheapest provider that supports the requested model:

```yaml
strategy:
  mode: cost_optimized
  targets: ["openai-main", "deepseek-cheap"]
targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    models: ["gpt-4o"]
    costPer1kInputTokens: 0.005
    costPer1kOutputTokens: 0.015
  - name: deepseek-cheap
    provider: deepseek
    apiKey: "sk-..."
    models: ["deepseek-chat"]
    costPer1kInputTokens: 0.0001
    costPer1kOutputTokens: 0.0002
```

### Content Based

Route based on keywords in the user prompt:

```yaml
strategy:
  mode: content_based
  keywords:
    code: "openai-main"
    translate: "deepseek-main"
    math: "groq-fast"
  targets: ["openai-main"]  # default
```

### A/B Test

Weighted traffic splitting with labels:

```yaml
strategy:
  mode: abtest
  targets: ["model-a", "model-b"]
  weights:
    model-a: 80
    model-b: 20
```

---

## Resilience

### Retry with Exponential Backoff

Configure per-target retry behavior. Backoff uses exponential jitter: `delay = random(0, initialBackoffMs × 2^(attempt-1))`.

```yaml
targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    retry:
      attempts: 3
      initialBackoffMs: 100
      onStatusCodes: [429, 500, 502, 503, 504]  # Default
```

- **4xx errors (except 429)** are never retried on the same target. 401/403/404 still fail over to the next target (see Fallback); other 4xx indicate a client problem
- **429 (rate limit)** is retried with backoff
- **5xx and network errors** are retried
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
- **OPEN**: All requests rejected with `CircuitOpenError` (503).
- **HALF_OPEN**: One probe request allowed. Success closes the breaker, failure reopens it.

---

## Plugins

Plugins run at three stages of the request lifecycle:

1. **`before_request`** — Modify or reject requests before they reach the provider
2. **`after_request`** — Inspect or modify responses after the provider returns
3. **`on_error`** — Handle errors from the provider

### Built-in Plugins

#### Rate Limit

Token-bucket rate limiter with global, per-key, and per-user limits.

```yaml
plugins:
  - name: rate-limit
    stage: before_request
    config:
      requestsPerSecond: 100    # Global rate (default: 100)
      burst: 200                # Burst capacity (default: 200)
      keyRpm: 60                # Per-API-key requests/minute
      userRpm: 30               # Per-user (from request `user` field) RPM
      maxKeys: 10000            # Max tracked keys, LRU eviction (default: 10000)
```

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

Content guardrail that rejects requests containing blocked words.

```yaml
plugins:
  - name: word-filter
    stage: before_request
    config:
      blockedWords: ["forbidden", "harmful"]
      caseSensitive: false      # Default: false
```

#### Max Token

Caps token count and message count in requests.

```yaml
plugins:
  - name: max-token
    stage: before_request
    config:
      maxTokens: 4096           # Max tokens per request (default: 4096)
      maxMessages: 100          # Max messages in conversation (default: 100)
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
```

#### Logger

Structured request/response logging.

```yaml
plugins:
  - name: logger
    stage: after_request
    config:
      logBody: false            # Log request/response bodies (default: false)
```

### Plugin Error Policy

- **Fail-open**: `logging`, `metrics` — if the plugin throws, the error is swallowed and the request continues
- **Fail-closed**: `guardrail`, `ratelimit`, `auth`, `transform` — if the plugin throws, the request fails with a 500 error

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
  - name: remote-tools
    type: http
    url: "https://mcp.example.com/sse"
    headers:
      Authorization: "Bearer sk-..."
```

**Agentic loop:**

```
User request → LLM returns tool_calls → Gateway executes tools via MCP
  → Tool results appended to messages → LLM called again
  → Repeat until no tool_calls or depth limit (default: 5)
  → Final response returned to user
```

- MCP tool calls have a 30-second timeout per call
- **Environment:** stdio servers do **not** inherit the gateway's environment. They get only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TZ`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TMPDIR` (plus the Windows basics `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`) and the server's own `env` map, so provider API keys, `ADMIN_BOOTSTRAP_KEY`, OTLP tokens and cloud credentials never reach third-party MCP packages. Pass what a server needs in `env`, list extra variable names with `inheritEnv: ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]`, or opt back into full inheritance with `inheritEnv: true` (not recommended).
- MCP tools are injected into **non-streaming** requests only. Streaming requests (`stream: true`) are forwarded without MCP tools and no agentic loop runs, so a streaming client never receives tool_calls for gateway-side tools it did not declare. Use a non-streaming request when you want the gateway to run MCP tools.

---

## Observability

### OpenTelemetry Tracing

```yaml
observability:
  tracing:
    enabled: true
    otlpEndpoint: "http://localhost:4318"
    otlpProtocol: http
    serviceName: "ai-gateway"
```

Spans created:

- `gateway.route` / `gateway.routeStream` — per-request root span
- `plugin.before_request.{name}` — per-plugin child spans
- `plugin.after_request.{name}`
- `plugin.on_error.{name}`
- `mcp.call_tool` — per MCP tool invocation

### Prometheus Metrics

```yaml
observability:
  metrics:
    enabled: true
```

Available at `GET /metrics`:

| Metric                           | Type      | Labels              |
| -------------------------------- | --------- | ------------------- |
| `ai_gateway_requests_total`      | counter   | `provider`, `model` |
| `ai_gateway_tokens_input_total`  | counter   | `provider`, `model` |
| `ai_gateway_tokens_output_total` | counter   | `provider`, `model` |
| `ai_gateway_request_duration_ms` | histogram | `provider`, `model` |

### Structured Logging

All requests are logged as structured JSON to stdout:

```json
{
  "timestamp": "2026-07-27T00:00:00.000Z",
  "requestId": "abc-123",
  "model": "gpt-4o",
  "provider": "openai-main",
  "strategy": "single",
  "durationMs": 1500,
  "tokens": {"prompt": 15, "completion": 8, "total": 23}
}
```

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

Admin endpoints require a secret:

```yaml
adminSecret: "a-long-random-secret-at-least-8-chars"
```

Send via `X-Admin-Secret` header or `Authorization: Bearer <secret>`. If no `adminSecret` is configured, admin endpoints are disabled (403).

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
requestTimeout: "30s"  # Go-style: 30s, 5m, 1h
```

Sets an `AbortController` that aborts the upstream fetch if exceeded.

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

- **`warn`** (default): Log a warning, strip the parameter, proceed
- **`drop`**: Silently strip the parameter
- **`reject`**: Return a 400 error

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
| `embed(ctx, req)`                    | Embedding generation                       |
| `embedWithPlugins(ctx, req)`         | Embedding with plugin lifecycle            |
| `generateImage(ctx, req)`            | Image generation                           |
| `generateImageWithPlugins(ctx, req)` | Image generation with plugin lifecycle     |
| `listModels()`                       | List all models                            |
| `registerProvider(provider)`         | Add a provider at runtime                  |
| `registerPlugin(stage, plugin)`      | Add a plugin at runtime                    |
| `getConfig()`                        | Get current config (read-only)             |
| `close()`                            | Graceful shutdown                          |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      HTTP Layer                         │
│  Hono App → Recover → BodyLimit → SecurityHeaders →    │
│  CORS → Auth → RequestTimeout → Handlers               │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   Gateway Core                          │
│                                                         │
│  ┌─────────────┐   ┌──────────┐   ┌─────────────────┐ │
│  │   Plugin     │   │ Strategy │   │ Circuit Breaker  │ │
│  │   Manager    │   │ Factory  │   │   Registry       │ │
│  └──────┬──────┘   └────┬─────┘   └────────┬────────┘ │
│         │               │                   │          │
│  before_request    ┌────▼─────┐         check/record   │
│  after_request     │ Provider  │                        │
│  on_error          │ Registry  │                        │
│                    └────┬─────┘                        │
│                         │                              │
│         ┌───────────────┼───────────────┐              │
│         ▼               ▼               ▼              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐       │
│  │  OpenAI    │  │  DeepSeek  │  │   Groq     │       │
│  │  Compat    │  │  Compat    │  │  Compat    │  ...   │
│  └────────────┘  └────────────┘  └────────────┘       │
│                                                         │
│  ┌─────────────┐   ┌──────────────┐                    │
│  │ MCP Registry │   │ MCP Executor  │                   │
│  └─────────────┘   └──────────────┘                    │
└─────────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                 Observability                            │
│  Tracing (OTel) │ Metrics (Prometheus) │ Request Log   │
└─────────────────────────────────────────────────────────┘
```

### Request Flow

```
Client Request
  │
  ├─ Middleware Stack (auth, body-limit, cors, security-headers, timeout)
  │
  ├─ Handler (validates request with Zod)
  │
  ├─ Gateway.route() or routeStream()
  │   │
  │   ├─ Model alias resolution
  │   ├─ Plugin: before_request
  │   ├─ Circuit breaker check
  │   ├─ Strategy → Provider selection
  │   ├─ Retry with backoff (if configured)
  │   ├─ Provider HTTP call (fetch to upstream API)
  │   ├─ Circuit breaker record (success/failure)
  │   ├─ MCP agentic loop (if tool_calls in response)
  │   ├─ Plugin: after_request
  │   └─ Observability (tracing, metrics, logging)
  │
  └─ Response to client
```

### Project Structure

```
src/
├── index.ts                   # Entry point + CLI + embedded mode exports
├── gateway.ts                 # Gateway core orchestrator
├── app.ts                     # Hono app factory + middleware wiring
│
├── config/
│   ├── schema.ts              # Zod validation schemas
│   ├── loader.ts              # YAML/JSON/env config loading
│   └── types.ts               # TypeScript type definitions
│
├── providers/
│   ├── types.ts               # IProvider, IStreamProvider, etc.
│   ├── registry.ts            # Provider registration and lookup
│   ├── openai-compat.ts       # Universal OpenAI-compatible adapter
│   ├── capabilities.ts        # Per-provider parameter support matrix
│   ├── sse-parser.ts          # SSE stream parser
│   └── definitions/           # 20+ provider config definitions
│
├── routing/
│   ├── types.ts               # IStrategy interface
│   ├── strategy-factory.ts    # Strategy construction
│   ├── retry.ts               # Exponential backoff retry
│   ├── circuit-breaker.ts     # Circuit breaker state machine
│   ├── single.ts              # Single target routing
│   ├── fallback.ts            # Fallback with error classification
│   ├── loadbalance.ts         # Weighted load balancing
│   ├── conditional.ts         # Field-pattern routing
│   ├── least-latency.ts       # p50 latency routing
│   ├── cost-optimized.ts      # Cost-based routing
│   ├── content-based.ts       # Keyword-based routing
│   └── abtest.ts              # A/B traffic splitting
│
├── plugins/
│   ├── types.ts               # IPlugin, Stage, PluginResult
│   ├── manager.ts             # Plugin execution with fail-open/closed
│   ├── context.ts             # PluginContext
│   ├── error.ts               # PluginRejectionError
│   └── builtins/              # 6 built-in plugins
│       ├── rate-limit.ts
│       ├── cache.ts
│       ├── logger.ts
│       ├── word-filter.ts
│       ├── max-token.ts
│       └── budget.ts
│
├── handlers/
│   ├── chat.ts                # POST /v1/chat/completions
│   ├── completions.ts         # POST /v1/completions
│   ├── embeddings.ts          # POST /v1/embeddings
│   ├── images.ts              # POST /v1/images/generations
│   ├── models.ts              # GET /v1/models
│   ├── capabilities.ts        # GET /v1/capabilities
│   └── health.ts              # GET /health, /livez, /readyz
│
├── middleware/
│   ├── auth.ts                # Bearer token auth (timing-safe)
│   ├── body-limit.ts          # Actual body size enforcement
│   ├── cors.ts                # CORS with multi-origin support
│   ├── security-headers.ts    # Standard security headers
│   ├── recover.ts             # Panic recovery
│   └── request-timeout.ts     # AbortController-based timeout
│
├── mcp/
│   ├── types.ts               # MCP protocol types
│   ├── client.ts              # MCP client (stdio/HTTP, with timeout)
│   ├── registry.ts            # MCP server registry
│   └── executor.ts            # Agentic tool-call loop
│
├── observability/
│   ├── tracing.ts             # OpenTelemetry tracing
│   ├── metrics.ts             # Prometheus metrics
│   └── request-log.ts         # Structured JSON logging
│
└── admin/
    ├── handlers.ts            # Admin sub-app with auth
    ├── config-handlers.ts     # Config CRUD
    ├── key-handlers.ts        # API key management
    └── log-handlers.ts        # Log viewing
```

---

## Development

### Scripts

```bash
bun run dev          # Start with file watching
bun run start        # Start without watching
bun run test         # Run all tests
bun run test:watch   # Run tests in watch mode
bun run typecheck    # Type-check with tsc
```

### Running Tests

```bash
# All tests (unit + integration)
bun test

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
| Dashboard UI                                  | Not included                           |
| `NonOpenAIWireProvider` proxy rejection       | Generic fallback with `baseURL`        |
| `sync.Pool` context pooling                   | Standard JS patterns                   |
| `httputil.ReverseProxy` pass-through          | Not included                           |
| Per-target concurrency limiter                | Not included (use circuit breaker)     |
| Model catalog / discovery                     | Static config only                     |
| Config file watcher                           | Not supported: edit the file and restart |
