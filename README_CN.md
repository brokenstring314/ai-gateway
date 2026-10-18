# AI Gateway

基于 TypeScript + Bun + Hono 的高性能 OpenAI 兼容 API 网关。

通过统一的端点将请求路由到 20+ 个 LLM 提供商，支持 8 种路由策略、6 个内置插件、熔断器、指数退避重试、MCP 智能体工具调用和完整的可观测性。

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

---

## CLI 命令参考

```
ai-gateway <命令> [选项]

命令：
  serve      启动网关服务
  validate   验证配置文件
  version    显示版本信息

选项：
  -c, --config <路径>   配置文件路径（YAML 或 JSON）
  -h, --help            显示帮助
  -v, --version         显示版本
```

### 示例

```bash
# 启动服务
ai-gateway serve -c config.yaml

# 仅验证配置（不启动）
ai-gateway validate -c config.yaml

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

strategy:
  mode: single              # single | fallback | loadbalance | conditional |
                             # least_latency | cost_optimized | content_based | abtest
  targets: ["openai-main"]  # 策略使用的目标名称
  weights:                  # 每个目标的权重（loadbalance、abtest）
    openai-main: 3
    deepseek-backup: 1
  rules:                    # 条件路由规则
    - field: "model"
      pattern: "^gpt-4"
      target: "openai-main"
  keywords:                 # 内容路由关键词
    code: "openai-main"
    translate: "deepseek"

targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    baseURL: "https://api.openai.com/v1"   # 可选，每个 provider 有默认值
    models: ["gpt-4o", "gpt-4o-mini"]
    weight: 3                               # 用于 loadbalance 策略
    costPer1kInputTokens: 0.005             # 用于 cost_optimized 策略
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

### 环境变量覆盖

任何配置字段都可以用 `AI_GATEWAY_` 前缀覆盖，用 `_` 作为路径分隔符：

```bash
AI_GATEWAY_SERVER_PORT=8080
AI_GATEWAY_AUTH_ENABLED=true
AI_GATEWAY_MAX_REQUEST_BYTES=20971520
```

字符串字段（如 `apiKey`、`adminSecret`）不会被自动转换为数字。

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
| `cloudflare`  | `https://api.cloudflare.com/client/v4/accounts`     |
| `databricks`  | `https://.databricks.com/serving-endpoints`         |
| `huggingface` | `https://api-inference.huggingface.co/v1`           |

任何未知的提供商，只要提供了 `baseURL`，就会被当作通用 OpenAI 兼容端点处理。

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
  "provider": "openai-main",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "你好！有什么可以帮你的？"},
    "finishReason": "stop"
  }],
  "usage": {"promptTokens": 15, "completionTokens": 8, "totalTokens": 23}
}
```

**流式响应**（`"stream": true`）：

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finishReason":""}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"！"},"finishReason":""}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finishReason":"stop"}],"usage":{"promptTokens":15,"completionTokens":2,"totalTokens":17}}

data: [DONE]
```

### Legacy Completions

```
POST /v1/completions
```

兼容旧版 `/v1/completions` 端点。Prompt 会在内部转换为单条用户消息。

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

其他 `/v1/*` 路由（如 `/v1/responses`、`/v1/files`）默认返回 **404**，除非开启透传代理：

```yaml
passthroughProxy:
  enabled: true   # 默认 false
```

开启后，请求会先运行 **before-request 插件**（限流、预算检查、对 `messages` / `input` / `prompt` / `instructions` 的敏感词过滤），再按 `X-Provider` 头或请求体顶层 `model` 原样转发。由于请求体结构未知，需要改写内容的插件（word-filter `redact`）或短路会直接返回 403。透传请求**没有**熔断、回退、after-request 插件和预算累计，因此默认关闭。

### 健康探针

| 端点            | 用途                           | 状态码       |
| ------------- | ---------------------------- | --------- |
| `GET /health` | 通用健康检查                       | 200       |
| `GET /livez`  | 进程存活（Kubernetes liveness 探针） | 200       |
| `GET /readyz` | 就绪检查（配置 + 提供商已加载）            | 200 / 503 |

### 指标

```
GET /metrics
```

Prometheus 格式的指标，包括：

- `ai_gateway_requests_total{provider, model}` — 请求计数
- `ai_gateway_tokens_input_total{provider, model}` — 输入 token 计数
- `ai_gateway_tokens_output_total{provider, model}` — 输出 token 计数
- `ai_gateway_request_duration_ms{provider, model}` — 延迟直方图

### 管理 API

所有管理端点都需要 `X-Admin-Secret` 请求头（或 `Authorization: Bearer <密钥>`）匹配配置中的 `adminSecret`。如果未配置 `adminSecret`，管理端点返回 403。

| 方法     | 路径                     | 说明                |
| ------ | ---------------------- | ----------------- |
| GET    | `/admin/config`        | 获取当前配置（API 密钥已脱敏） |
| PUT    | `/admin/config`        | 替换配置（Zod 验证）      |
| POST   | `/admin/config/reload` | 从文件重新加载配置         |
| GET    | `/admin/keys`          | 列出 API 密钥（脱敏）     |
| POST   | `/admin/keys`          | 添加新的 API 密钥       |
| DELETE | `/admin/keys/:id`      | 按索引删除 API 密钥      |
| GET    | `/admin/logs`          | 查看最近的日志条目         |

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

`ADMIN_BOOTSTRAP_KEY` / `ADMIN_BOOTSTRAP_READ_ONLY_KEY` 仅在密钥库为空时有效（`auth.keys` 不计入），因此在创建第一个密钥之前一直有效；在此期间启动时会打印警告。

### 响应头

网关在响应中添加以下头：

| 头                        | 说明                                |
| ------------------------ | --------------------------------- |
| `X-Gateway-Provider`     | 处理请求的提供商名称                        |
| `X-Gateway-Overhead-Ms`  | 网关处理时间（毫秒）                        |
| `X-Content-Type-Options` | `nosniff`                         |
| `X-Frame-Options`        | `DENY`                            |
| `Referrer-Policy`        | `strict-origin-when-cross-origin` |

---

## 路由策略

所有多目标策略（fallback、loadbalance、least_latency、cost_optimized、conditional、content_based、abtest）都会生成一个**有序候选列表**（首选目标在前），并交给同一个执行器：候选目标熔断器打开、达到并发上限、或出现可切换错误（网络错误、5xx、408、429、401/403/404）时跳过，尝试下一个候选（按各目标自己的 `retry` 配置）。调用方导致的 4xx（400/409/413/422 等）、客户端中断和网关请求超时会直接结束请求。流式请求只在第一个 chunk 之前切换。conditional / content_based 只从命中的目标切换到默认目标。least_latency 中尚无样本的目标优先尝试；刚失败的目标在 30 秒内（或作为候选成功之前）排在最后。`/v1/embeddings` 和 `/v1/images/generations` 使用相同的策略顺序（仅保留支持该模型和能力的目标），同样经过熔断器、并发限制、重试和故障切换。

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

按权重分配请求：

```yaml
strategy:
  mode: loadbalance
  targets: ["openai-main", "deepseek-alt"]
  weights:
    openai-main: 3
    deepseek-alt: 1
```

### Conditional（条件路由）

根据请求字段匹配路由（支持正则）：

```yaml
strategy:
  mode: conditional
  rules:
    - field: "model"
      pattern: "^g7pt-4"
      target: "openai-main"
    - field: "model"
      pattern: "^deepseek"
      target: "deepseek-main"
  targets: ["openai-main"]  # 默认目标
```

### Least Latency（最低延迟）

路由到观测 p50 延迟最低的目标：

```yaml
strategy:
  mode: least_latency
  targets: ["openai-main", "groq-fast", "cerebras-fast"]
```

### Cost Optimized（成本优化）

路由到支持请求模型且最便宜的提供商：

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

### Content Based（内容路由）

根据用户提示中的关键词路由：

```yaml
strategy:
  mode: content_based
  keywords:
    code:@ "openai-main"
    translate: "deepseek-main"
    math: "groq-fast"
  targets: ["openai-main"]  # 默认
```

### A/B Test（A/B 测试）

带标签的加权流量分流：

```yaml
strategy:
  mode: abtest
  targets: ["model-a", "model-b"]
  weights:
    model-a: 80
    model-b: 20
```

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

令牌桶限流器，支持全局、按密钥和按用户限制。

```yaml
plugins:
  - name: rate-limit
    stage: before_request
    config:
      requestsPerSecond: 100    # 全局速率（默认：100）
      burst: 200                # 突发容量（默认：200）
      keyRpm: 60                # 每个 API 密钥的每分钟请求数
      userRpm: 30               # 每个用户（来自请求 user 字段）的 RPM
      maxKeys: 10000            # 最大追踪密钥数，LRU 淘汰（;默认：10000）
```

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

#### Token 限制（Max Token）

限制请求中的 token 数和消息数。

```yaml
plugins:
  - name: max-token
    stage: before_request
    config:
      maxTokens: 4096           # 每个请求的最大 token 数（默认：4096）
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
```

#### 日志（Logger）

结构化请求/响应日志。

```yaml
plugins:
  - name: logger
    stage: after_request
    config:
      logBody: false            # 是否记录请求/响应体（默认：false）
```

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
  - name: remote-tools
    type: http
    url: "https://mcp.example.com/sse"
    headers:
      Authorization: "Bearer sk-..."
```

**智能体循环：**

```
用户请求 → LLM 返回 tool_calls → 网关通过 MCP 执行工具
  → 工具结果追加到消息 → 再次调用 LLM
  → 重复直到无 tool_calls 或达到深度限制（默认：5）
  → 最终响应返回给用户
```

- MCP 工具调用有 30 秒超时
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

```yaml
observability:
  metrics:
    enabled: true
```

通过 `GET /metrics` 获取：

| 指标                               | 类型        | 标签                  |
| -------------------------------- | --------- | ------------------- |
| `ai_gateway_requests_total`      | counter   | `provider`, `model` |
| `ai_gateway_tokens_input_total`  | counter   | `provider`, `model` |
| `ai_gateway_tokens_output_total` | counter   | `provider`, `model` |
| `ai_gateway_request_duration_ms` | histogram | `provider`, `model` |

### 结构化日志

所有请求以结构化 JSON 格式输出到 stdout：

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

- **`warn`**（默认）：记录警告，移除参数，继续
- **`drop`**：静默移除参数
- **`reject`**：返回 400 错误

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
| `embed(ctx, req)`                    | Embedding 生成                       |
| `embedWithPlugins(ctx, req)`         | 带插件生命周期的 Embedding                 |
| `generateImage(ctx, req)`            | 图片生成                               |
| `generateImageWithPlugins(ctx, req)` | 带插件生命周期的图片生成                       |
| `listModels()`                       | 列出所有模型                             |
| `registerProvider(provider)`         | 运行时添加提供商                           |
| `registerPlugin(stage, plugin)`      | 运行时添加插件                            |
| `reloadConfig(config)`               | 热重载配置                              |
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
├── gateway.ts                 # Gateway 核心协调器
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
│   └── definitions/           # 20+ 提供商配置定义
│
├── routing/
│   ├── types.ts               # IStrategy 接口
│   ├── strategy-factory.ts    # 策略构造
│   ├── retry.ts               # 指数退避重试
│   ├── circuit-breaker.ts     # 熔断器状态机
│   ├── single.ts              # 单目标路由
│   ├── fallback.ts            # 降级回退（含错误分类）
│   ├── loadbalance.ts         # 加权负载均衡
│   ├── conditional.ts         # 字段-模式条件路由
│   ├── least-latency.ts       # p50 延迟路由
│   ├── cost-optimized.ts      # 成本优化路由
│   ├── content-based.ts       # 关键词内容路由
│   └── abtest.ts              # A/B 流量分流
│
├── plugins/
│   ├── types.ts               # IPlugin、Stage、PluginResult
│   ├── manager.ts             # 插件执行（故障开放/关闭）
│   ├── context.ts             # PluginContext
│   ├── error.ts               # PluginRejectionError
│   └── builtins/              # 6 个内置插件
│       ├── rate-limit.ts      # 限流
│       ├── cache.ts           # 响应缓存
│       ├── logger.ts          # 日志
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
│   ├── client.ts              # MCP 客户端（stdio/HTTP，带超时）
│   ├── registry.ts            # MCP 服务器注册表
│   └── executor.ts            # 智能体工具调用循环
│
├── observability/
│   ├── tracing.ts             # OpenTelemetry 链路追踪
│   ├── metrics.ts             # Prometheus 指标
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
| Dashboard UI                        | 不包含                               |
| `NonOpenAIWireProvider` 代理拒绝        | 带 `baseURL` 的通用回退                 |
| `sync.Pool` 上下文池                    | 标准 JS 模式                          |
| `httputil.ReverseProxy` 透传代理        | 不包含                               |
| 每目标并发限制                             | 不包含（使用熔断器替代）                      |
| 模型目录 / 动态发现                         | 仅静态配置                             |
| 配置文件监视                              | 管理 API 重载（`PUT /admin/config`）    |
