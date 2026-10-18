# AI Gateway

基于 TypeScript + Bun + Hono 的高性能 OpenAI 兼容 API 网关。

通过统一的端点将请求路由到 20+ 个 LLM 提供商，支持 4 种路由策略、6 个内置插件（含 PII 与密钥防护）、熔断器、指数退避重试、MCP 智能体工具调用和完整的可观测性。

---

## 快速开始

### 前置条件

- [Bun](https://bun.sh/) 1? 1.3+

### 安装与运行

```bash
git clone <仓库地址> && cd ai-gateway-rewrite
bun install
```

创建配置文件：

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
    apiKey: "sk-你的密钥"
    models: ["gpt-4o", "gpt-4o-mini"]
```

启动网关：

```bash
bun run src/index.ts serve -c config.yaml
```

测试：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好！"}]
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

镜像以非 root 用户（uid 1000）在 `tini` 下运行，并设置 `GATEWAY_ENV=production`
（配置必须开启 auth 且至少有一个 key；`adminSecret` 至少 16 个字符）和
`GATEWAY_DATA_DIR=/data`（API key 与请求日志；挂载 volume 以持久化）。配置文件挂载到
`/config/config.yaml`（只读即可）。内置 `HEALTHCHECK` 探测 3000 端口的 `/livez`；
负载均衡 / k8s readiness 请用 `/readyz`。`docker stop` 发送 SIGTERM：`/readyz` 变为 503，
不再接受新连接，进行中的请求在 `SHUTDOWN_GRACE_MS`（默认 10000）内排空。
CI 用 `scripts/docker-smoke.sh <image>` 对镜像做冒烟测试。

---

## CLI 命令参考

```
ai-gateway <命令> [选项]

命令：
  serve      启动网关服务
  validate   验证配置文件
  keys       直接管理 API 密钥库（create | list | revoke）
  version    显示版本信息

选项：
  -c, --config <路径>   配置文件路径（YAML 或 JSON）
  -p, --port <端口>     覆盖 server.port（serve）
  -h, --host <地址>     覆盖 server.host（serve）
  --data-dir <目录>     数据目录（keys；默认 GATEWAY_DATA_DIR 或 ./.data）
  --help                显示帮助
  -v, --version         显示版本

ai-gateway keys create [--admin] [--read-only] [--name <名称>] [--expires <ISO>] [--json] -c <配置>
ai-gateway keys list   [--json] -c <配置>
ai-gateway keys revoke <id> -c <配置>
```

`ai-gateway serve`、`bun src/index.ts serve` 和 `bun src/cli/index.ts serve` 是同一个 CLI，都通过同一个 `bootstrap()` 启动服务（key store、生产环境安全检查、客户端鉴权、OpenTelemetry、优雅关闭）。嵌入方可以从包入口调用 `bootstrap(configPath, { port, host, dataDir })`，返回带 `stop()` 的句柄。

### 示例

```bash
# 启动服务
ai-gateway serve -c config.yaml

# 仅验证配置（不启动）
ai-gateway validate -c config.yaml

# 恢复管理员权限（服务运行中也可执行）；新密钥只打印一次
ai-gateway keys create --admin --name ops-recovery -c config.yaml

# 显示版本
ai-gateway version
```

---

## 配置

网关从 YAML 或 JSON 文件读取配置。所有配置项均可通过 `AI_GATEWAY_` 前缀的环境变量覆盖。

### 最小配置

```yaml
strategy:
  mode: single
  targets: ["my-provider"]
targets:
  - name: my-provider
    provider: openai
    apiKey: "sk-..."
```

### 完整配置参考

```yaml
apiVersion: v1

server:
  port: 3000                # HTTP 端口（默认：3000）
  host: "0.0.0.0"          # 绑定地址（默认：0.0.0.0）
  perIpRateLimit:           # /v1/* 按客户端 IP 的令牌桶；rps > 0 才启用（默认关闭）
    rps: 50                 #   每个 IP 每秒请求数（环境变量 RATE_LIMIT_RPS 优先）
    burst: 100              #   桶容量，默认 2 × rps（环境变量 RATE_LIMIT_BURST 优先）

strategy:
  mode: single              # single | fallback | loadbalance | conditional
  targets: ["openai-main"]  # 策略使用的目标名称
  weights:                  # 每个目标的权重（loadbalance；0 = 摘除）
    openai-main: 3
    deepseek-backup: 1
  rules:                    # 条件路由规则（第一条命中的生效）
    - field: "model"        # model | user | message | prompt
      pattern: "^gpt-4"     # 正则，或 contains: "<子串>"
      target: "openai-main"

targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    baseURL: "https://api.openai.com/v1"   # 可选，每个 provider 有默认值
    models: ["gpt-4o", "gpt-4o-mini"]
    weight: 3                               # 用于 loadbalance 策略
    costPer1kInputTokens: 0.005             # 价格（budget 插件 / 指标）
    costPer1kOutputTokens: 0.015
    retry:                                  # 每个目标的重试配置
      attempts: 3                           # 最大尝试次数（默认：1 = 不重试）
      initialBackoffMs: 100                 # 基础退避时间（默认：100ms）
      onStatusCodes: [429, 500, 502, 503]  # 可重试的状态码
    circuitBreaker:                         # 每个目标的熔断器
      failureThreshold: 5                   # 连续失败多少次后熔断（默认：5）
      successThreshold: 1                   # 半开状态成功多少次后恢复（默认：1）
      timeoutMs: 30000                      # 熔断到半开的超时时间（默认：30000ms）

  - name: deepseek-backup
    provider: deepseek
    apiKey: "sk-..."
    models: ["deepseek-chat"]

auth:
  enabled: true
  keys:
    - "sk-my-api-key-1"
    - "sk-my-api-key-2"

adminSecret: "一个安全的管理员密钥至少8个字符"

cors:
  enabled: true
  origins:
    - "https://my-app.example.com"
    - "http://localhost:3000"

maxRequestBytes: 10485760       # 10 MB 请求体限制（默认）
requestTimeout: "30s"           # Go 风格时长：30s、5m、1h

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
      blockedWords: ["禁止词", "blocked"]
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

compatibility:
  onUnsupportedParam: warn      # warn | drop | reject

mcpServers:
  - name: my-tools
    type: stdio
    command: "node"
    args: ["my-mcp-server.js"]        # 只支持 stdio 传输

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

### 环境变量覆盖

任何配置字段都可以用 `AI_GATEWAY_` 前缀覆盖，用 `_` 作为路径分隔符：

```bash
AI_GATEWAY_SERVER_PORT=8080
AI_GATEWAY_AUTH_ENABLED=true
AI_GATEWAY_MAX_REQUEST_BYTES=20971520   # 驼峰键：maxRequestBytes
AI_GATEWAY_CORS_ORIGINS=https://a.example,https://b.example   # 数组：逗号分隔
```

各段按不区分大小写的方式匹配配置键（相邻的段会拼成驼峰键）。值按字段类型转换，所以字符串字段（如 `apiKey`、`adminSecret`）不会被转换为数字。不对应任何配置键的变量会被忽略并打印警告。

### 运行时环境变量

以下变量直接从环境读取（不经过 `AI_GATEWAY_*`）：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `GATEWAY_DATA_DIR` | `.data`（相对于工作目录） | SQLite 数据库所在目录（见下文），应放在持久卷上。 |
| `GATEWAY_ENV` | 未设置 | 设为 `production` 时启用启动安全检查：拒绝 `auth.enabled: false`、`ALLOW_UNAUTHENTICATED_PROXY=true`、少于 16 个字符的 `adminSecret`，以及完全没有客户端密钥（无 `auth.keys` 且密钥库为空）时启动。 |
| `ADMIN_BOOTSTRAP_KEY` | 未设置 | 首次启动用的管理员凭据；一旦存在真正的管理员凭据即被拒绝，创建过 admin 密钥后永久拒绝（见[密钥作用域](#密钥作用域密钥库模式)）。 |
| `ADMIN_BOOTSTRAP_READ_ONLY_KEY` | 未设置 | 同上，`read_only` 权限。 |
| `ALLOW_UNAUTHENTICATED_PROXY` | `false` | `true` 时允许可选的透传代理在没有客户端密钥时转发。`GATEWAY_ENV=production` 下被拒绝。 |
| `RATE_LIMIT_RPS` | 未设置（限流关闭） | `/v1/*` 按客户端 IP 的每秒请求数，优先于 `server.perIpRateLimit.rps`；`0` 表示关闭。 |
| `RATE_LIMIT_BURST` | 2 × rps | 每个 IP 的桶容量，优先于 `server.perIpRateLimit.burst`。 |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | 逗号分隔的 IP/CIDR，来自这些地址的 `X-Forwarded-For` / `X-Real-IP` 才被按 IP 限流信任。部署在负载均衡后面时请设为 LB 的地址段，否则所有请求共享 LB 的 IP。 |
| `SHUTDOWN_GRACE_MS` | `10000` | 收到 SIGTERM/SIGINT 后等待在途请求完成的时间（毫秒）。关闭顺序：`/readyz` 立即返回 503，已有连接上的新请求返回 503 `shutting_down`；监听器停止接受新连接；等待在途请求完成（响应带 `Connection: close`）；最后关闭监听器和存储。 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 未设置 | 未配置 `observability.tracing.otlpEndpoint` 时使用的 OTLP HTTP 端点。 |
| `OTEL_TRACES_SAMPLER` | 未设置 | `always_on`、`always_off` 或 `traceidratio`（使用 `sampleRatio`）；其他值被忽略。 |

**按 IP 限流**默认关闭。网关直接暴露在公网时，用 `server.perIpRateLimit`（或 `RATE_LIMIT_RPS`）开启；在负载均衡后面时还要设置 `TRUSTED_PROXIES`。超限请求返回 `429`、`{"error": {"code": "rate_limited", ...}}` 和 `Retry-After` 头（秒）。限流桶按进程计算，空闲的桶会被清理。

**数据目录（`GATEWAY_DATA_DIR`，默认 `./.data`）** 包含：

- `api-keys.sqlite` — API 密钥库：密钥的 SHA-256 哈希（不存明文）、显示前缀、名称、权限、过期时间和使用计数。丢失它等于吊销所有密钥库中的密钥；能写入它的人就能伪造密钥，请保持私有（目录 `chmod 700`）。
- `request-logs.sqlite` — `/admin/logs` 使用的请求日志：trace id、模型、提供商、token 数和错误信息（不含提示词和回复）。错误信息可能引用上游响应内容。
- `gateway-config.sqlite` — 仅 0.2.0 之前的版本会生成；现在被忽略（会打印警告），可以删除。

---

## 支持的提供商

所有提供商均使用 OpenAI 兼容协议。网关根据提供商适配请求/响应格式。

| 提供商           | 默认 Base URL                                         |
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
| `cloudflare`  | 无：需设置 `baseURL`（`https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`） |
| `databricks`  | 无：需设置 `baseURL`（`https://<workspace>.cloud.databricks.com/serving-endpoints`） |
| `huggingface` | `https://api-inference.huggingface.co/v1`           |

任何未知的提供商，只要提供了 `baseURL`，就会被当作通用 OpenAI 兼容端点处理；未知提供商且没有 `baseURL` 会在启动时报错。`nvidia-nim` 是 `nvidia_nim` 的别名。`openrouter` 目标会发送 `HTTP-Referer` / `X-Title` 归属头。`baseURL` 可以包含 `${VAR}` 引用（如 `"${OPENAI_BASE_URL}"`、`"http://localhost:${PORT}/v1"`），展开后必须是 http(s) URL。

参数支持按 `provider`（预设）查找，而不是按目标的 `name`：名为 `my-mistral`、`provider: mistral` 的目标会使用 Mistral 的能力检查（见“兼容性模式”）。

---

## API 端点

### Chat Completions

```
POST /v1/chat/completions
```

完全兼容 OpenAI Chat Completions API，包括：

- 流式响应（`"stream": true`）通过 SSE
- 函数调用 / 工具（`tools`、`tool_choice`）
- 响应格式（`text`、`json_object`、`json_schema`）
- `logprobs` 和 `top_logprobs`
- `seed` 用于确定性输出
- `stream_options.include_usage` 在最终 chunk 中包含用量
- `max_tokens` / `max_completion_tokens`
- `parallel_tool_calls`
- `tools[].function.strict`
- 网关不建模的字段按白名单双向透传。请求：`reasoning_effort`、`verbosity`、`store`、`metadata`、`modalities`、`audio`、`prediction`、`service_tier`、`web_search_options`、`prompt_cache_key`、`safety_identifier` 以及常见厂商参数（`top_k`、`min_p`、`repetition_penalty`、`reasoning`、`thinking`、`enable_thinking`、`chat_template_kwargs`、Perplexity 的 `search_*` / `return_*`）；消息上的 `reasoning_content` / `reasoning` / `refusal` / `audio` / `prefix`。响应与流式 chunk：`system_fingerprint`、`service_tier`、`citations`、`search_results`；`choices[].logprobs`；message / delta 上的 `reasoning_content`、`reasoning`、`refusal`、`annotations`、`audio`；usage 的 `prompt_tokens_details`、`completion_tokens_details`、`cost`。其他未知字段仍会丢弃。

**请求：**

```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": "你是一个有用的助手。"},
    {"role": "user", "content": "你好！"}
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false
}
```

**非流式响应：**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "gpt-4o",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "你好！有什么可以帮你的？"},
    "logprobs": null,
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 15, "completion_tokens": 8, "total_tokens": 23}
}
```

**流式响应**（`"stream": true`）：

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"！"},"logprobs":null,"finish_reason":"stop"}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":15,"completion_tokens":2,"total_tokens":17}}

data: [DONE]
```

### Legacy Completions

```
POST /v1/completions
```

OpenAI 旧版 completions 线上格式。Prompt 转成单条用户消息，走 chat 管线（插件、路由、回退）。支持标准 snake_case 参数（`max_tokens`、`top_p`、`presence_penalty`、`frequency_penalty`、`logit_bias`、`stop`、`n`、`seed`、`user`、`stream_options`；整数 `logprobs` 映射为 chat 的 `top_logprobs`）。响应是 `text_completion`（`choices[].text`、`finish_reason`、旧版 `logprobs`：`tokens` / `token_logprobs` / `top_logprobs` / `text_offset`，snake_case 的 `usage`），流式 chunk 同形。chat 无法表达的选项返回 400 `validation_failed`：`echo: true`、非空 `suffix`、`best_of` > 1、批量 prompt（多于一个元素的数组）。

### Embeddings

```
POST /v1/embeddings
```

```json
{
  "model": "text-embedding-3-small",
  "input": "你好世界"
}
```

### 图片生成

```
POST /v1/images/generations
```

```json
{
  "model": "dall-e-3",
  "prompt": "山间的日落",
  "n": 1,
  "size": "1024x1024"
}
```

### 模型列表

```
GET /v1/models
```

返回所有已配置提供商的所有模型：

```json
{
  "object": "list",
  "data": [
    {"id": "gpt-4o", "object": "model", "owned_by": "openai-main"},
    {"id": "deepseek-chat", "object": "model", "owned_by": "deepseek-backup"}
  ]
}
```

### 能力查询

```
GET /v1/capabilities
```

返回每个提供商的参数支持配置（哪些 OpenAI 参数被支持）。

### 其他 `/v1/*` 路由（透传代理，需显式开启）

路由前会先规范化路径：重复斜杠、末尾斜杠、`%2F` 以及上述路由的大小写变体（如 `/v1/chat/completions/`、`/v1//chat/completions`、`/V1/Chat/Completions`）都会进入真正的处理器，因此始终经过插件、熔断和回退。

对上述路由使用其他方法（如 `GET /v1/chat/completions`、`DELETE /v1/completions`）返回 **405** `method_not_allowed`，带 `Allow` 头，绝不透传。

其他 `/v1/*` 路由（如 `/v1/responses`、`/v1/files`）默认返回 **404**，除非开启透传代理：

```yaml
passthroughProxy:
  enabled: true   # 默认 false
  routes:         # 方法+路径白名单；以下即默认值
    - POST /v1/responses
    - POST /v1/moderations
    - POST /v1/audio/*       # /* = 任意子路径
```

只转发白名单内的路由，其他一律 **403** `route_not_allowed`。默认只放无状态的 POST：所有透传请求都使用 target 唯一的上游密钥，列出/读取/删除已存对象的路由（`GET /v1/files`、`DELETE /v1/files/{id}`、`GET /v1/responses/{id}`、batches、vector stores、已存的 chat completions）会让一个客户端访问到所有其他客户端的数据。只有网关只服务单一租户时才应加入这类路由。条目格式为 `"METHOD /v1/path"` 或 `"METHOD /v1/prefix/*"`（方法写 `*` 表示任意方法）；含编码斜杠的路径永不转发。

开启后，请求会先运行 **before-request 插件**（限流、预算检查、对 `messages` / `input` / `prompt` / `instructions` 的敏感词过滤；max-token 作用于 `max_output_tokens` / `max_tokens` / `max_completion_tokens`，`/v1/responses` 未设置时注入 `max_output_tokens`），再按 `X-Provider` 头或请求体顶层 `model` 原样转发。由于请求体结构未知，需要改写内容的插件（word-filter `redact`）或短路会直接返回 403；被封顶的 token 上限会写入转发的请求体。透传请求**没有**熔断、回退、after-request 插件和预算累计，因此默认关闭。

### 健康探针

| 端点            | 用途                           | 状态码       |
| ------------- | ---------------------------- | --------- |
| `GET /health` | 通用健康检查                       | 200       |
| `GET /livez`  | 进程存活（Kubernetes liveness 探针）。仅当某个 `required` MCP 服务器连续 5 次重连失败时返回 503，让编排系统重启 Pod | 200 / 503 |
| `GET /readyz` | 就绪检查：配置和提供商已加载、配置存储与必需的 MCP 服务器可用、未处于排空状态。上游熔断器状态**不**影响就绪（所有副本共享同一上游，否则会把整个集群同时摘除），仅在响应体中以 `circuitBreakers` / `upstreamAvailable` 报告。收到 SIGTERM/SIGINT 开始排空后立即返回 503，排空期间新请求返回 503 | 200 / 503 |

### 指标

```
GET /metrics
```

Prometheus 格式的指标，包括：

- `ai_gateway_requests_total{method, status, provider}` — HTTP 请求计数
- `ai_gateway_request_duration_seconds{method, status, provider}` — 延迟直方图
- `ai_gateway_tokens_input_total{provider, model}` — 输入 token 计数（chat）
- `ai_gateway_tokens_output_total{provider, model}` — 输出 token 计数（chat）
- `ai_gateway_plugin_blocked_total{plugin, outcome, surface}` — 被 before-request 插件结束的请求

### 管理 API

所有管理端点都需要 `X-Admin-Secret` 请求头（或 `Authorization: Bearer <密钥>`）匹配配置中的 `adminSecret`。如果未配置 `adminSecret`，管理端点返回 403。

| 方法     | 路径                     | 说明                |
| ------ | ---------------------- | ----------------- |
| GET    | `/admin/config`        | 获取当前配置（已脱敏：API 密钥、admin secret、客户端密钥、URL 中的凭据、OTLP 头、MCP env/args、插件配置里疑似密钥的字段；完整的 `${VAR}` 模板原样显示） |
| GET    | `/admin/keys`          | 列出 API 密钥（脱敏）     |
| POST   | `/admin/keys`          | 添加新的 API 密钥       |
| DELETE | `/admin/keys/:id`      | 按索引删除 API 密钥      |
| GET    | `/admin/logs`          | 请求日志（新的在前）；`limit`（≤200）、`offset`，过滤 `stage`（surface）、`model`、`provider`（target）、`since`、`status=error\|ok` |
| GET    | `/admin/logs/stats`    | 按 surface/target/model 计数、错误数、token（同样的过滤） |
| GET    | `/admin/status`        | 控制台概览：调用方 `scopes`、各 target 的 `circuitBreakers`、`upstreamAvailable`、`mcpServers`、本进程请求摘要（数量、4xx/5xx、错误率、延迟 mean/p50/p95） |

运行时配置只读：没有热重载，也没有配置写接口（0.2.0 起移除；旧的写接口返回 `410 config_api_removed`）。改配置 = 改文件 + 重启（负载均衡后面滚动重启）。收到 `SIGHUP` 只打日志，不做任何事。

**示例：**

```bash
# 获取配置
curl -H "X-Admin-Secret: my-secret" http://localhost:3000/admin/config

# 添加密钥
curl -X POST \
  -H "X-Admin-Secret: my-secret" \
  -H "Content-Type: application/json" \
  -d '{"key": "sk-new-key"}' \
  http://localhost:3000/admin/keys
```

#### 密钥作用域（密钥库模式）

服务器使用 API 密钥库运行时（`ai-gateway serve` / `bun src/index.ts serve`），`POST /admin/keys` 接受 `{"name": "...", "scopes": [...], "expiresAt"?: "..."}`，生成的密钥只返回一次。作用域：

| 作用域        | `/v1/*` | `GET /admin/*` | 修改类 `/admin/*` |
| ------------- | ------- | -------------- | ----------------- |
| `inference`   | 允许    | 403            | 403               |
| `read_only`   | 允许    | 允许           | 403               |
| `admin`       | 允许    | 允许           | 允许              |

未提供 `scopes`（或为 `[]`）创建的密钥默认为 `["inference"]`；管理员权限必须显式指定 `"scopes": ["admin"]`。其他取值（非数组、非字符串元素、未知名称）在创建和更新时均返回 400。旧版本中未指定作用域创建的密钥存储为 `["admin"]`，请用 `GET /admin/keys` 检查，并用 `PUT /admin/keys/:id {"scopes": ["inference"]}` 降级。

`ADMIN_BOOTSTRAP_KEY` / `ADMIN_BOOTSTRAP_READ_ONLY_KEY` 只用于首次启动。只有在**还没有任何真正的管理员凭据**时才接受（分别授予 `admin` / `read_only` 权限），只要满足以下任一条件就会被拒绝：

- 密钥库中曾经创建过 admin 密钥（即下文的 **bootstrap 闩锁**），例如执行过 `POST /admin/keys {"name": "ops", "scopes": ["admin"]}`；
- 配置了 `adminSecret`；
- 配置了 `auth.keys`。

只有 inference 或 `read_only` 权限的密钥不会让它们失效（否则先创建客户端密钥会把你锁在管理 API 之外）。每个请求都会重新检查，因此创建第一个 admin 密钥后 bootstrap 密钥立即失效。bootstrap 密钥有效期间启动时会打印警告；被拒绝时（启动时或运行中）会记录日志 `[auth] ADMIN_BOOTSTRAP_KEY / ADMIN_BOOTSTRAP_READ_ONLY_KEY disabled: <原因>`。拿到管理员凭据后请把这两个变量从环境中删除。没有密钥库时（嵌入式 `createApp(gateway, config)`）它们永远不被接受。

**Bootstrap 闩锁（单向）。** 密钥库中第一次出现 admin 权限的密钥时（无论是用 bootstrap 密钥、`adminSecret` 创建，还是 `PUT` 授予 `admin`，或通过 CLI 创建），会在写入密钥的同一事务中记录下来。此后 bootstrap 密钥**永久**被拒绝，返回与无效密钥相同的 401，即使之后所有 admin 密钥都被吊销、过期或删除也不会恢复。旧版本的密钥库如果已经包含任何 admin 密钥（active、已吊销或已过期），升级时即视为已上锁。两个用 bootstrap 密钥认证的请求同时创建 admin 密钥时，只有第一个成功。已上锁但 `ADMIN_BOOTSTRAP_KEY` 仍在环境中时，启动时会打印一行警告：`... permanently disabled: bootstrap latch is set ... remove them from the environment`。

#### 恢复管理员权限

如果已经没有可用的管理员凭据（admin 密钥全部吊销或过期、也没有 `adminSecret`），在网关所在主机上用 CLI 创建新的 admin 密钥。它打开与 `serve` 相同的密钥库（`<数据目录>/api-keys.sqlite`；数据目录 = `--data-dir`、`GATEWAY_DATA_DIR` 或 `./.data`），服务运行中也可以安全执行（WAL 模式 + busy timeout），服务在下一个请求即可接受新密钥：

```bash
GATEWAY_DATA_DIR=/var/lib/ai-gateway ai-gateway keys create --admin --name ops-recovery -c config.yaml
# stdout：新密钥，只打印一次（--json 同时输出 id/name/scopes）；其他信息输出到 stderr
ai-gateway keys list -c config.yaml            # id、名称、作用域、状态、闩锁状态；不输出密钥
ai-gateway keys revoke <id> -c config.yaml
```

可选：`--expires 2027-01-01T00:00:00Z`、`--read-only`（代替 `--admin`；都不指定则为 `inference`）。该命令会校验配置，但不会打印配置或除新密钥以外的任何秘密；数据目录下没有密钥库时直接报错（不会新建），所以数据目录写错会立即暴露。Docker 中：`docker exec <容器> bun src/index.ts keys create --admin -c /config/config.yaml`（镜像已设置 `GATEWAY_DATA_DIR=/data`）。

### 管理控制台

内置一个小型 Web 控制台，地址 **`/admin/dashboard`**（无构建步骤、无框架、不加载外部资源）：

| 页面 | 内容 | 数据来源 |
| ---- | ---- | -------- |
| 概览（`/admin/dashboard`） | 就绪状态、各 target 熔断器状态、`upstreamAvailable`、MCP 服务器状态、请求数 / 错误率 / 延迟、按 surface、target、model 的请求数；每 15 秒刷新 | `/readyz`、`/admin/status`、`/admin/logs/stats` |
| API 密钥（`/admin/dashboard/keys`） | 密钥列表（scope、状态、过期时间、使用量）。admin 可创建密钥（scope `inference` / `read_only` / `admin`，可选过期时间；新密钥只显示一次）、轮换、吊销。`read_only` 只能查看列表 | `/admin/keys` |
| 请求日志（`/admin/dashboard/logs`） | 分页（每页 50 条），可按 surface、target、model、状态（ok/error）和时间过滤 | `/admin/logs` |
| 配置（`/admin/dashboard/config`） | 当前运行配置，已脱敏，只读 | `/admin/config` |

在 `/admin/dashboard/login` **登录**：输入密钥库中带 `admin` 或 `read_only` scope 的密钥（或 `adminSecret`）。密钥只保存在当前标签页的 `sessionStorage` 中，以 `Authorization: Bearer` 发送，不使用 cookie；关闭标签页或点"Sign out"即清除。仅有 inference scope 的密钥会被拒绝（403）。

HTML 页面和 `/admin/static/console.{js,css}` 不需要认证，因为它们不含任何数据（浏览器导航无法携带 Bearer 头）；页面上的所有数据都来自上面需要认证的管理 API。页面带严格 CSP（`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`，无内联脚本），脚本只把 API 数据作为文本插入，从不作为 HTML 解析。与其他管理 API 一样，`/admin/*` 只应暴露在可信网络中。

概览页的请求数字有两个来源："Logged requests" 和按 surface 的表格来自请求日志库（重启后仍在）；"Upstream-served" 和延迟来自本进程启动以来的 Prometheus 注册表（延迟分位数是直方图桶的上界）。历史数据请看 `/metrics`。

### 响应头

网关在响应中添加以下头：

| 头                        | 说明                                |
| ------------------------ | --------------------------------- |
| `X-Gateway-Provider`     | 处理请求的提供商名称                        |
| `X-Gateway-Target`       | 仅错误响应：产生错误的目标（不会出现在响应体中） |
| `X-Gateway-Overhead-Ms`  | 网关处理时间（毫秒）                        |
| `X-Content-Type-Options` | `nosniff`                         |
| `X-Frame-Options`        | `DENY`                            |
| `Referrer-Policy`        | `strict-origin-when-cross-origin` |

### 错误响应

所有 `/v1` 端点的错误都是 OpenAI 形状 `{"error": {"message", "type", "code", "param"}}`。
目标名和上游 URL 不会出现在响应体里；出错的目标放在 `X-Gateway-Target` 响应头和服务端日志中。

| 情形 | 状态码 | `code` |
| --- | --- | --- |
| JSON 无效 / 校验失败 | 400 | `invalid_json` / `validation_failed` |
| 没有目标支持该模型 | 404 | `model_not_found` |
| 插件拒绝（word-filter 等） | 403 | `plugin_rejected` |
| `pii-secret-guard` 拦截（请求 / 响应） | 400 / 422 | `secret_detected` / `pii_detected` |
| `rate-limit` / `budget` 插件拒绝 | 429（rate-limit 带 `Retry-After`） | `plugin_rejected` |
| 上游 4xx（400、404、413、422 等） | 原状态码 | 上游 `code`；上游 `message`/`type`/`param` 原样保留 |
| 上游 429 | 429，透传上游 `Retry-After` | 上游 `code`（默认 `rate_limit_exceeded`） |
| 上游 401/403（切换后仍失败） | 502 | `upstream_auth_failed` |
| 上游 5xx | 502 | 上游 `code`（默认 `upstream_error`） |
| 网络错误 / 连接重置 / 200 但 body 不是 JSON | 502 | `upstream_unavailable` / `upstream_invalid_response` |
| 所有候选目标熔断器都打开 | 503，带 `Retry-After` | `circuit_open` |
| 本地并发队列已满 | 429 | `gateway_overloaded` |
| 网关请求超时 | 504 | `gateway_timeout` |
| 其他 | 500 | `Internal server error`（固定文案） |

尝试了多个目标时，返回最有意义的那个错误：上游 4xx > 上游 429 > 上游 401/403 > 超时 > 上游 5xx > 网络错误 > 本地过载 > 熔断打开。

---

## 路由策略

可用策略有 4 种：`single`、`fallback`、`loadbalance`、`conditional`（`least_latency`、`cost_optimized`、`content_based`、`abtest` 已在 0.2.0 移除，见下文“已移除的策略”）。策略只负责生成**有序候选列表**（首选目标在前），由同一个执行器（`src/core/executor.ts`）执行：候选目标熔断器打开、达到并发上限（队列已满，或在排队时请求截止时间已到——返回 429 `gateway_overloaded`，且不计入熔断失败）、或出现可切换错误（网络错误、5xx、408、429、401/403/404）时跳过，尝试下一个候选（按各目标自己的 `retry` 配置）。调用方导致的 4xx（400/409/413/422 等）、客户端中断和网关请求超时会直接结束请求。流式请求只在第一个 chunk 之前切换。conditional 只从命中的目标切换到默认目标。`/v1/embeddings` 和 `/v1/images/generations` 使用相同的策略顺序（仅保留支持该模型和能力的目标），同样经过熔断器、并发限制、重试和故障切换。

### Single（单目标）

将所有请求路由到一个目标：

```yaml
strategy:
  mode: single
  targets: ["openai-main"]
```

### Fallback（降级回退）

按顺序尝试目标。失败时（5xx、408、429、网络错误、熔断器打开）尝试下一个。上游 **401/403**（该目标的凭据被吊销或无权限）和 **404**（该目标上不存在该模型/部署）也会切换到下一个目标；401/403 同时计入熔断失败，404 不计入。调用方导致的 4xx（400、409、413、422 等）立即失败，不切换、不影响熔断。每个目标可以配置指数退避重试。

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

### Load Balance（负载均衡）

按权重分配请求（加权随机；其余目标按权重顺序作为故障切换候选）。权重为 `0` 表示摘除该目标：不分配任何流量，也不作为切换候选。至少要有一个权重大于 0。权重取值顺序：`targets[].weight`，然后 `strategy.weights`，默认 1。

```yaml
strategy:
  mode: loadbalance
  targets: ["openai-main", "deepseek-alt"]
  weights:
    openai-main: 3
    deepseek-alt: 1
```

### Conditional（条件路由）

按请求字段路由。规则按顺序检查，第一条命中的生效；都不命中时使用 `strategy.targets` 的第一个作为默认目标（命中规则时它也是故障切换目标）。每条规则有一个 `field`，以及 `pattern`（正则，启动时校验）和 `contains`（不区分大小写的子串）二者之一：

| `field`   | 匹配对象                      |
| --------- | ------------------------- |
| `model`   | 请求的模型                     |
| `user`    | 请求的 `user` 字段             |
| `message` | 第一条消息的文本                  |
| `prompt`  | 所有 user 消息的文本（换行拼接）       |

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
  targets: ["openai-main"]  # 默认目标
```

### 已移除的策略（0.2.0）

以下写法现在会让 `ai-gateway validate` 和启动直接报错，并给出迁移提示：

| 已移除                                         | 改用                                                   |
| ------------------------------------------- | ---------------------------------------------------- |
| `least_latency`                             | `fallback`，targets 按偏好顺序排列                           |
| `cost_optimized`（及 `unpricedStrategy`）      | `fallback`，targets 按价格从低到高排列                         |
| `content_based`（及 `keywords`、`contentConditions`） | `conditional` + `field: prompt` 规则（`contains` 或 `pattern`） |
| `abtest`（及 `abVariants`）                    | `loadbalance` + `weights`。`abtest` 暂时作为 `loadbalance` 的废弃别名保留（启动时告警），0.3.0 移除 |
| `strategy.conditions`（Go 的 `key/value/target_key`） | `strategy.rules: [{ field, pattern, target }]`  |

---

## 弹性机制

### 指数退避重试

为每个目标配置重试行为。退避使用指数抖动：`延迟 = random(0, initialBackoffMs × 2^(尝试次数-1))`。

```yaml
targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    retry:
      attempts: 3
      initialBackoffMs: 100
      onStatusCodes: [429, 500, 502, 503, 504]  # 默认值
```

- **4xx 错误（429 除外）不在同一目标上重试**。401/403/404 仍会切换到下一个目标（见 Fallback）；其他 4xx 表示客户端问题
- **429（限流）** 会重试并退避
- **5xx 和网络错误** 会重试
- **AbortSignal** 取消会被立即响应

### 熔断器

每个目标的熔断器防止级联故障：

```yaml
targets:
  - name: flaky-provider
    provider: openai
    apiKey: "sk-..."
    circuitBreaker:
      failureThreshold: 5       # 连续失败多少次后熔断（默认：5）
      successThreshold: 1       # 半开状态成功多少次后恢复（默认：1）
      timeoutMs: 30000          # 熔断多久后进入半开（默认：30000ms）
```

**状态机：**

```
关闭（CLOSED） ──── 连续失败达阈值 ────→ 打开（OPEN）
  ↑                                          │
  │                                超时时间到期
  │                                          ↓
  └──── 半开成功达阈值 ──── 半开（HALF_OPEN）
                                        │
                               探测失败 → 打开（OPEN）
```

- **关闭**：所有请求通过。计算连续失败次数。
- **打开**：所有请求被拒绝，返回 `CircuitOpenError`（503）。
- **半开**：允许一个探测请求。成功则关闭熔断器，失败则重新打开。

---

## 插件

插件在请求生命周期的三个阶段运行：

1. **`before_request`** — 请求到达提供商前修改或拒绝
2. **`after_request`** — 提供商返回后检查或修改响应
3. **`on_error`** — 处理来自提供商的错误

### 内置插件

#### 限流（Rate Limit）

按 API 密钥限流，使用固定窗口计数器（每个密钥 O(1) 内存和 CPU；空闲密钥会被清理）。

```yaml
plugins:
  - name: rate-limit
    stage: before_request
    config:
      maxRequestsPerMinute: 60  # 必填（别名：keyRpm、rpm）
      maxRequestsPerDay: 5000   # 可选（别名：rpd）；不设置时不跟踪日窗口
      key: shared               # 可选，没有 API 密钥的请求使用的桶名（默认："default"）
```

窗口从该密钥的第一个请求开始计时，60 秒 / 24 小时后重置，因此跨越窗口边界的突发最多可放行两倍限额。限额按进程计算（多副本之间不共享）。被拒绝时返回 429 `plugin_rejected`，并带 `Retry-After`（距窗口重置的秒数）。`budget` 插件拒绝同样返回 429。

#### 响应缓存（Cache）

LRU 缓存，键基于所有有意义的请求参数（model、messages、temperature、tools、seed、maxTokens 等）。

```yaml(8)
plugins:
  - name: cache
    stage: before_request
    config:
      maxAge: 300               # 缓存 TTL（秒，默认：300）
      maxEntries: 1000          # 最大缓存条目数（默认：1000）
```

#### 词过滤（Word Filter）

内容安全护栏，拒绝包含屏蔽词的请求。

```yaml
plugins:
  - name: word-filter
    stage: before_request
    config:
      blockedWords: ["禁止词", "有害内容"]
      caseSensitive: false      # 默认：false
```

匹配在 Unicode NFKC 规范化后的文本上进行且不区分大小写，因此兼容字符变体（开尔文符号 `K`、全角 `ｋｉｌｌ`、长 `ſ`）也能识别。`mode: redact` 时命中的词替换为 `***`（被改写的文本以 NFKC 形式转发）；如果检测到但无法替换，则直接拒绝请求。它只是粗粒度的子串过滤：零宽字符和其他文字系统的形近字仍可绕过。

#### 敏感信息与密钥防护（PII & Secret Guard）

检测个人信息（PII）和凭据（密钥），并按配置**拦截**、**脱敏**或**仅记录**。

```yaml
plugins:
  - name: pii-secret-guard
    stage: before_request
    type: guardrail
    config:
      action: block                 # 所有检测的默认动作：block | redact | log（默认 block）
      categories:                   # 可选，按类别覆盖 action
        secret: block
        pii: redact
      entityActions:                # 可选，按实体覆盖；在此列出的实体会被自动启用
        ipv4: log
        phone: log
      # entities: [email, phone, credit_card]   # 可选：只扫描这些内置实体（默认：除 ipv4 外全部）
      allowlist: ["@example\\.com$"] # 正则，作用于每个匹配到的“值”；命中则忽略
      patterns:                     # 可选：自定义检测器
        - { name: employee_id, pattern: "EMP-\\d{6}", category: pii, action: redact }
      surfaces: [chat, completions, embeddings, passthrough]   # 默认全部四个
      roles: [system, user, assistant, tool, developer]        # 默认全部
      direction: request            # request（默认）| response | both
      scanToolArguments: true       # 扫描 assistant 的工具调用参数（默认 true）
      entropyThreshold: 3.5         # 通用 `api_key=` / `password=` 赋值的熵阈值（比特/字符，默认 3.5）
```

| 类别 | 实体 |
| --- | --- |
| `secret` | `private_key`（PEM 私钥块）、`anthropic_key`（`sk-ant-…`）、`openai_key`（`sk-…`，含 DeepSeek 等 OpenAI 兼容厂商）、`aws_access_key`（`AKIA`/`ASIA`）、`aws_secret_key`（`aws…secret… =` 赋值中）、`github_token`（`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`）、`slack_token`（`xox*-`、`xapp-`）、`google_api_key`（`AIza…`）、`stripe_key`（`sk_/rk_` `live/test`）、`jwt`、`generic_secret`（`api_key=` / `password:` / `client_secret=` 等，值的熵高于阈值） |
| `pii` | `email`、`phone`（中国大陆手机号 `1[3-9]x`，可带 `+86`；E.164；带分隔的国际号码；美国号码）、`cn_id`（18 位居民身份证，GB 11643 校验位 + 合法日期）、`credit_card`（Luhn + 发卡行前缀）、`iban`（mod-97）、`ssn`（美国，`123-45-6789` 形式）、`ipv4`（需显式启用） |

- **扫描范围：** `roles` 中角色的每条消息——字符串内容、每个文本 content part，以及（除非 `scanToolArguments: false`）assistant 的工具调用参数。`/v1/completions` 的 `prompt` 和 `/v1/embeddings` 的 `input` 按 user 消息扫描；透传路由扫描代理提取出的文本（`messages` / `input` / `prompt` / `instructions`）。文本先做 Unicode NFKC 规范化（与 word-filter 相同）并去除零宽和双向控制字符，因此全角数字、`s\u200Bk-…` 也能检出。校验器（Luhn、身份证校验位、IBAN mod-97、JWT 头、熵）用于降低误报；重叠时更具体的实体优先（`api_key=sk-…` 记为 `openai_key`）。
- **block：** 返回 `400`，`code` 为 `secret_detected` 或 `pii_detected`（`type: "invalid_request_error"`）；消息只包含实体类型，绝不回显匹配到的值。同一请求中只要有一个 block，就优先于 redact/log。
- **redact：** 将值替换为类型化占位符——`[EMAIL]`、`[PHONE]`、`[CN_ID]`、`[CREDIT_CARD]`、`[SECRET:github_token]`、`[CUSTOM:employee_id]`——并以 NFKC 形式转发。工具调用参数保持为合法 JSON（若脱敏会破坏 JSON 则改为拦截）。透传路由无法转发改写后的请求体，因此在透传路由上 redact 会改为**拦截**。
- **log：** 原样转发，只记录检测结果。
- **响应扫描**（`direction: response | both`）：扫描非流式 chat 和 completions 响应（消息内容和工具调用参数）；block 返回 `422`（错误码同上），redact 改写客户端收到的响应。**流式响应不扫描**：数据块一旦发给客户端就无法撤回，而安全的跨块扫描需要缓冲输出。流式请求的请求方向扫描照常生效。请把本插件放在 `cache` 之前，这样缓存的是脱敏后的响应。
- **可观测性：** 请求日志增加 `guardrail: [{plugin, direction, action, entities}]`（只有实体类型，绝无匹配文本）；`ai_gateway_guardrail_detections_total{entity,category,action,direction}` 统计检测次数；拦截会计入 `ai_gateway_plugin_blocked_total`（请求为 `outcome="plugin_rejected"`，响应为 `"response_rejected"`）。
- 配置使用严格 schema：未知的键、实体、动作、surface、角色或非法正则都会让 `ai-gateway validate` 和启动失败。

设计参考 ferro-labs/ai-gateway 的 `pii-redact` 与 `secret-scan` 插件（Apache-2.0），详见 NOTICE。

#### Token 限制（Max Token）

限制请求中的 token 数和消息数。

```yaml
plugins:
  - name: max-token
    stage: before_request
    config:
      maxTokens: 4096           # 每个请求的最大输出 token 数；请求未设置时注入（默认：4096）
      maxMessages: 100          # 对话中的最大消息数（默认：100）
```

#### 预算控制（Budget）

每个 API 密钥的每日 USD 预算控制。

```yaml
plugins:
  - name: budget
    stage: before_request
    config:
      dailyBudget: 100          # 每日消费限额（美元）
      costPer1kInput: 0.01     # 每 1K 输入 token 的成本
      costPer1kOutput: 0.03    # 每 1K 输出 token 的成本
      reserveOutputTokens: 1024 # 可选：请求未设 max_tokens 时预留的输出 token 数
```

每个请求发送前先按估算预留费用（prompt 约 4 字符/token，加上其 `max_tokens`
或 `reserveOutputTokens`），完成后按实际用量结算；无论请求如何结束，预留都会释放。
同一密钥还有在途请求时，只有估算能放进剩余额度的请求才会被放行，因此并发不会冲破预算。
未配置 `costPer1kInput` / `costPer1kOutput` 时使用实际服务 target 的
`costPer1kInputTokens` / `costPer1kOutputTokens`；任何地方都没有费率的 budget
配置直接报错（否则永远不会生效）。

#### 日志（Logger，0.2.0 已移除）

`logger` 插件与网关自带的请求日志（每个请求一行 JSON，见“结构化日志”）重复。`plugins` 里的 `logger` 条目会被忽略并在启动时告警，请删除。

### 插件错误策略

- **故障开放（Fail-open）**：`logging`、`metrics` — 插件抛异常时吞掉错误，请求继续
- **故障关闭（Fail-closed）**：`guardrail`、`ratelimit`、`auth`、`transform` — 插件抛异常时请求失败，返回 500

---

## MCP（模型上下文协议）

网关支持外部 MCP 工具服务器。配置后，网关会：

1. 启动时从 MCP 服务器发现工具
2. 将工具定义注入到 chat completion 请求中
3. 当 LLM 返回 `tool_calls` 时执行智能体循环
4. 用工具结果重新调用 LLM，直到没有更多 tool_calls 或达到最大深度

```yaml
mcpServers:
  - name: filesystem
    type: stdio
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

只支持 stdio 传输。`type: http` / `url` / `headers`（从未实现）已在 0.2.0 从 schema 中移除，校验时直接报错。

**智能体循环：**

```
用户请求 → LLM 返回 tool_calls → 网关通过 MCP 执行工具
  → 工具结果追加到消息 → 再次调用 LLM
  → 重复直到无 tool_calls 或达到深度限制（默认：5）
  → 最终响应返回给用户
```

- MCP 工具调用有 30 秒超时
- **崩溃恢复：** stdio 服务器启动失败或进程退出后，网关在后台以指数退避（1 秒、2 秒、4 秒……上限 60 秒）自动重连，并记录每次断开、失败和恢复（`[mcp] server "name" ...`）。断开期间其工具不可用（若为 `required`，`/readyz` 返回 503）。`required` 服务器连续 5 次重连失败后，`/livez` 返回 503，让 Kubernetes 重启 Pod，而不是留下一个永远不就绪的副本。
- **环境变量：** stdio 服务器**不会**继承网关的环境变量，只拿到 `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`TERM`、`TZ`、`LANG`、`LANGUAGE`、`LC_ALL`、`LC_CTYPE`、`TMPDIR`（以及 Windows 基础变量 `SYSTEMROOT`、`WINDIR`、`COMSPEC`、`PATHEXT`、`TEMP`、`TMP`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`）和该服务器自己的 `env`，因此提供商 API 密钥、`ADMIN_BOOTSTRAP_KEY`、OTLP token、云凭据都不会泄露给第三方 MCP 包。服务器需要的值写在 `env` 里；额外需要透传的变量名用 `inheritEnv: ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]` 列出；`inheritEnv: true` 恢复完整继承（不推荐）。
- MCP 工具只注入**非流式**请求。流式请求（`stream: true`）不注入 MCP 工具、也不运行智能体循环，因此流式客户端不会收到它未声明的网关侧工具的 tool_calls。需要网关执行 MCP 工具时请使用非流式请求。

---

## 可观测性

### OpenTelemetry 链路追踪

```yaml
observability:
  tracing:
    enabled: true
    otlpEndpoint: "http://localhost:4318"
    otlpProtocol: http
    serviceName: "ai-gateway"
```

创建的 Span：

- `gateway.route` / `gateway.routeStream` — 每个请求的根 span
- `plugin.before_request.{name}` — 每个插件的子 span
- `plugin.after_request.{name}`
- `plugin.on_error.{name}`
- `mcp.call_tool` — 每个 MCP 工具调用

### Prometheus 指标

`GET /metrics`（无需鉴权）默认挂在主端口：

```yaml
observability:
  metrics:
    enabled: true   # false：完全不提供 /metrics
    port: 9090      # 可选；与 server.port 不同时单独监听
```

没有 `observability.metrics` 配置块时，`/metrics` 仍在主端口。

| 指标                               | 类型        | 标签                  |
| -------------------------------- | --------- | ------------------- |
| `ai_gateway_requests_total`      | counter   | `method`, `status`, `provider` |
| `ai_gateway_request_duration_seconds` | histogram | `method`, `status`, `provider` |
| `ai_gateway_tokens_input_total`  | counter   | `provider`, `model` |
| `ai_gateway_tokens_output_total` | counter   | `provider`, `model` |
| `ai_gateway_request_cost_usd`    | counter   | `provider`, `model`（target 配了 `costPer1k*Tokens` 时） |
| `ai_gateway_provider_errors_total` | counter | `provider`, `error_type`（每次失败的上游尝试，含已 failover 的） |
| `ai_gateway_circuit_breaker_state` | gauge   | `provider`, `state`（当前状态为 1） |
| `ai_gateway_mcp_server_up`       | gauge     | `server` |
| `ai_gateway_rate_limit_rejections_total` | counter | `provider` |
| `ai_gateway_plugin_blocked_total` | counter  | `plugin`, `outcome`, `surface` |

### 结构化日志

每个请求恰好记录一次，以结构化 JSON 输出到 stdout（同时写入 `GET /admin/logs` 与 dashboard 使用的请求日志库）：

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

## 安全

### 身份认证

配置 API 密钥认证：

```yaml
auth:
  enabled: true
  keys:
    - "sk-my-first-key"
    - "sk-my-second-key"
```

客户端必须发送 `Authorization: Bearer <密钥>`。`/health`、`/livez`、`/readyz`、`/metrics` 和 `/admin/*` 路径跳过认证。

**除非显式设置 `auth.enabled: false`，客户端认证始终开启**（省略 `auth` 或 `enabled` 均视为开启），并且 `bun src/index.ts serve`、`ai-gateway serve` CLI（复用同一启动流程，包括 API 密钥库）以及嵌入式 `createApp(gateway, config)` 的行为一致。可用凭据为 `auth.keys`，以及传入密钥库时库中的密钥。认证开启但没有任何凭据时，所有 `/v1/*` 请求返回 401（默认拒绝），启动时会打印警告。

API 密钥比较使用常量时间相等性比较，防止时序攻击。

### 管理员认证

管理端点需要密钥：

```yaml
adminSecret: "一个足够长的随机密钥至少8个字符"
```

通过 `X-Admin-Secret` 头或 `Authorization: Bearer <密钥>` 发送。如果未配置 `adminSecret`，管理端点被禁用（返回 403）。

### 请求体大小限制

```yaml
maxRequestBytes: 10485760  # 10 MB（默认）
```

同时检查 `Content-Length` 头/和实际请求体大小。

### 安全头

所有响应包含：

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
  # allowHeaders: ["Content-Type", "Authorization"]  # 可选；默认反射浏览器的
  #   Access-Control-Request-Headers（SDK 的 x-stainless-*、openai-organization、
  #   openai-project 等请求头需要）
```

### 请求超时

```yaml
requestTimeout: "30s"  # Go 风格：30s、5m、1h
```

设置 `AbortController`，超时后中止上游 fetch。

---

## 模型别名

将友好名称映射到实际模型 ID：

```yaml
aliases:
  fast: "gpt-4o-mini"
  smart: "gpt-4o"
  cheap: "deepseek-chat"
```

客户端可以使用 `"model": "fast"`，网关会解析为 `"gpt-4o-mini"`。

---

## 兼容性模式

不同提供商支持不同的 OpenAI 参数。兼容性模式控制当客户端发送提供商不支持的参数时如何处理：

```yaml
compatibility:
  onUnsupportedParam: warn  # warn | drop | reject
```

- **`warn`**（默认）：记录警告，请求原样发送
- **`drop`**：发送前移除不支持的参数（对不支持 developer 角色的提供商，`developer` 消息改为 `system`；图片内容保留并告警）
- **`reject`**：返回 400，列出不支持的参数（wire 名称，如 `seed`、`stream_options`）

检查依据目标的 `provider`（如 `mistral`、`ollama`、`replicate`、`cloudflare`、`huggingface` 支持的参数较少）；不在矩阵中的提供商视为全部支持。

---

## 嵌入模式

在你的应用中将网关作为库使用：

```typescript
import { Gateway, createApp, loadConfigFromPath } from "ai-gateway-rewrite";

// 加载配置
const config = loadConfigFromPath("./config.yaml");

// 创建网关
const gateway = new Gateway(config);
await gateway.initMcp();

// 编程式调用
const response = await gateway.route(
  { metadata: {} },
  { model: "gpt-4o", messages: [{ role: "user", content: "你好" }] }
);

// 或创建 HTTP 应用
const app = createApp(gateway, config);
// 配合任何 Hono 兼容的服务器使用。
// 这里同样执行客户端认证：/v1/* 需要 auth.keys 中的 Bearer 密钥
// （认证开启且 auth.keys 为空时一律 401）。如需无认证的进程内应用，请显式设置 auth.enabled: false。

// 清理
gateway.close();
```

### Gateway API

| 方法                                   | 说明                                 |
| ------------------------------------ | ---------------------------------- |
| `route(ctx, req)`                    | 非流式 Chat Completion                |
| `routeStream(ctx, req)`              | 流式 Chat Completion（AsyncGenerator） |
| `execute(surface, req, ctx)`         | 任意 surface（`core/surfaces/*`）走完整 pipeline |
| `executeStream(surface, req, ctx)`   | chat 形状的 surface（chat、completions）流式执行 |
| `embed(ctx, req)`                    | Embedding 生成                       |
| `embedWithPlugins(ctx, req)`         | 带插件生命周期的 Embedding                 |
| `generateImage(ctx, req)`            | 图片生成                               |
| `generateImageWithPlugins(ctx, req)` | 带插件生命周期的图片生成                       |
| `listModels()`                       | 列出所有模型                             |
| `registerProvider(provider)`         | 运行时添加提供商                           |
| `registerPlugin(stage, plugin)`      | 运行时添加插件                            |
| `getConfig()`                        | 获取当前配置（只读）                         |
| `close()`                            | 优雅关闭                               |

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                      HTTP 层                            │
│  Hono App → Recover → BodyLimit → SecurityHeaders →    │
│  CORS → Auth → RequestTimeout → Handlers               │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   Gateway 核心                          │
│                                                         │
│  ┌─────────────┐   ┌──────────┐   ┌─────────────────┐ │
│  │   插件       │   │  策略    │   │   熔断器        │ │
│  │   管理器     │   │  工厂    │   │   注册表        │ │
│  └──────┬──────┘   └────┬─────┘   └────────┬────────┘ │
│         │               │                   │          │
│  before_request    ┌────▼─────┐         检查/记录      │
│  after_request     │ 提供商    │                        │
│  on_error          │ 注册表   │                        │
│                    └────┬─────┘                        │
│                         │                              │
│         ┌───────────────┼───────────────┐              │
│         ▼               ▼               ▼              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐       │
│  │  OpenAI    │  │  DeepSeek  │  │   Groq     │       │
│ G │  Compat   │  │  Compat    │  │  Com)pat    │  ...   │
│  └────────────┘  └────────────┘  └────────────┘       │
│                                                         │
│  ┌─────────────┐   ┌──────────────┐                    │
│  │ MCP 注册表  │   │ MCP 执行器   │                    │
│  └─────────────┘   └──────────────┘                    │
└─────────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   可观测性                               │
│  链路追踪 (OTel) │ 指标 (Prometheus) │ 请求日志        │
└─────────────────────────────────────────────────────────┘
```

### 请求流程

```
客户端请求
  │
  ├─ 中间件栈（auth、body-limit、cors、security-headers、timeout）
  │
  ├─ Handler（用 Zod 验证请求）
  │
  ├─ Gateway.route() 或 routeStream()
  │   │
  │   ├─ 模型别名解析
  │   ├─ 插件：before_request
  │   ├─ 熔断器检查
  │   ├─ 策略 → 提供商选择
  │   ├─ 指数退避重试（如已配置）
  │   ├─ 提供商 HTTP 调用（fetch 到上游 API）
  │   ├─ 熔断器记录（成功/失败）
  │   ├─ MCP 智能体循环（如响应中有 tool_calls）
  │   ├─ 插件：after_request
  │   └─ 可观测性（追踪、指标、日志）
  │
  └─ 响应返回客户端
```

### 项目结构

```
src/
├── index.ts                   # 入口 + CLI + 嵌入模式导出
├── gateway.ts                 # Gateway 外观（嵌入式 API）
├── app.ts                     # Hono 应用工厂 + 中间件连接
│
├── config/
│   ├── schema.ts              # Zod 验证 schema
│   ├── loader.ts              # YAML/JSON/环境变量配置加载
│   └── types.ts               # TypeScript 类型定义
│
├── providers/
│   ├── types.ts               # IProvider、IStreamProvider 等接口
│   ├── registry.ts            # 提供商注册和查找
│   ├── openai-compat.ts       # 通用 OpenAI 兼容适配器
│   ├── capabilities.ts        # 每个提供商的参数支持矩阵
│   ├── sse-parser.ts          # SSE 流解析器
│   └── （预设：src/core/provider-presets.ts，一张表覆盖 20+ 提供商）
│
├── core/
│   ├── assembly.ts            # 配置 → 提供商、插件、策略、熔断、执行器、pipeline
│   ├── pipeline.ts            # execute(surface, req, ctx)：插件 → 执行器 → MCP 循环 → 只 finalize 一次
│   ├── chat-stream.ts         # chat / completions 的 executeStream（每个流只 finalize 一次）
│   ├── stream-runner.ts       # 首 chunk、流结束原因、SSE 输出
│   ├── surfaces/              # chat、completions、embeddings、images、passthrough
│   ├── mcp-loop.ts            # MCP agentic 循环（usage 累加）
│   ├── mcp-runtime.ts         # MCP 服务器连接 / 就绪状态
│   ├── strategy-config.ts     # config.strategy → 策略模式和配置
│   ├── usage.ts               # usage 累加、流式估算、costOf
│   ├── executor.ts            # 候选执行器：熔断 → 并发限制 → 调用 → 结算 → 切换，含重试
│   ├── outcome.ts             # 尝试结果分类（熔断结算、是否切换）
│   ├── errors.ts              # GatewayError、toGatewayError、OpenAI 错误格式
│   └── provider-presets.ts    # 提供商预设表
│
├── routing/
│   ├── types.ts               # IStrategy 接口（只有 selectTargets）
│   ├── strategy-factory.ts    # 策略构造
│   ├── concurrency-limiter.ts # 每目标并发槽位，排队可中断
│   ├── retry.ts               # 指数退避重试
│   ├── circuit-breaker.ts     # 熔断器状态机
│   ├── single.ts              # 单目标路由
│   ├── fallback.ts            # 降级回退（含错误分类）
│   ├── loadbalance.ts         # 加权负载均衡
│   └── conditional.ts         # 字段 / prompt 规则路由
│
├── plugins/
│   ├── types.ts               # IPlugin、Stage、PluginResult
│   ├── manager.ts             # 插件执行（故障开放/关闭）
│   ├── context.ts             # PluginContext
│   ├── error.ts               # PluginRejectionError
│   └── builtins/              # 6 个内置插件
│       ├── rate-limit.ts      # 限流
│       ├── cache.ts           # 响应缓存
│       ├── word-filter.ts     # 词过滤
│       ├── max-token.ts       # Token 限制
│       └── budget.ts          # 预算控制
│
├── handlers/
│   ├── chat.ts                # POST /v1/chat/completions
│   ├── completions.ts         # POST /v1/completions
│   ├── embeddings.ts          # POST /v1/embeddings
│   ├── images.ts              # POST /v1/images/generations
│   ├── models.ts              # GET /v1/models
│   ├── capabilities.ts        # GET /v1/capabilities
│   └── health.ts              # GET /health、/livez、/readyz
│
├── middleware/
│   ├── auth.ts                # Bearer token 认证（常量时间比较）
│   ├── body-limit.ts          # 实际请求体大小强制
│   ├── cors.ts                # CORS 多源支持
│   ├── security-headers.ts    # 标准安全头
│   ├── recover.ts             # 异常恢复
│   └── request-timeout.ts     # AbortController 超时
│
├── mcp/
│   ├── types.ts               # MCP 协议类型
│   ├── client.ts              # MCP 客户端（stdio，带超时）
│   ├── registry.ts            # MCP 服务器注册表
│   └── executor.ts            # 智能体工具调用循环
│
├── observability/
│   ├── tracing.ts             # 链路追踪门面（OpenTelemetry 桥接）
│   └── request-log.ts         # 结构化 JSON 日志
│
└── admin/
    ├── handlers.ts            # 管理子应用（带认证）
    ├── config-handlers.ts     # 配置 CRUD
    ├── key-handlers.ts        # API 密钥管理
    └── log-handlers.ts        # 日志查看
```

---

## 开发

### 脚本

```bash
bun run dev          # 启动（文件监视）
bun run start        # 启动（无监视）
bun run test         # 运行所有测试
bun run test:watch   # 监视模式运行测试
bun run typecheck    # tsc 类型检查
```

### 运行测试

```bash
# 所有测试（单元 + 集成）
bun test

# 指定测试文件
bun test tests/unit/routing/fallback.test.ts

# 监视模式
bun run test:watch
```

---

## 从 Go ai-gateway 迁移

| Go 功能                               | TypeScript 对应                     |
| ----------------------------------- | --------------------------------- |
| `ferrogw serve`                     | `ai-gateway serve -c config.yaml` |
| 29 个提供商（含 Anthropic/Gemini/Bedrock） | 20+ 个 OpenAI 兼容提供商                |
| 非 OpenAI 线路协议翻译                     | 不支持（设计决策）                         |
| Dashboard UI                        | 精简管理控制台（`/admin/dashboard`） |
| `NonOpenAIWireProvider` 代理拒绝        | 带 `baseURL` 的通用回退                 |
| `sync.Pool` 上下文池                    | 标准 JS 模式                          |
| `httputil.ReverseProxy` 透传代理        | 不包含                               |
| 每目标并发限制                             | 不包含（使用熔断器替代）                      |
| 模型目录 / 动态发现                         | 仅静态配置                             |
| 配置文件监视                              | 不支持：改文件后重启                   |

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。

本项目的设计源自 [Ferro Labs AI Gateway](https://github.com/ferro-labs/ai-gateway)（Apache-2.0），署名保留在 [NOTICE](NOTICE)。
