# AI Gateway

基于 TypeScript + Bun + Hono 的高性能 OpenAI 兼容 API 网关。

通过统一的端点将请求路由到 20+ 个 LLM 提供商，支持 4 种路由策略、6 个内置插件（含 PII 与密钥防护）、熔断器、指数退避重试、MCP 智能体工具调用和完整的可观测性。

> **致谢：** 本项目的设计源自 [Ferro Labs AI Gateway](https://github.com/ferro-labs/ai-gateway)（Apache-2.0）。感谢 Ferro Labs 团队；详见 [NOTICE](NOTICE)。

---

## 快速开始

### 安装

**Docker 镜像**（linux/amd64、linux/arm64），来自 GitHub Container Registry：

```bash
docker pull ghcr.io/brokenstring314/ai-gateway:0.2.0   # 或 :0.2、:latest
docker run -d --name ai-gateway -p 3000:3000 \
  -v "$PWD/config.yaml:/config/config.yaml:ro" \
  -v ai-gateway-data:/data \
  -e OPENAI_API_KEY \
  ghcr.io/brokenstring314/ai-gateway:0.2.0
```

镜像的运行要求（生产模式、必须开启 auth）见下文 [Docker](#docker)。

**预编译二进制**（单文件，无需安装 Bun）：从
[Releases](https://github.com/brokenstring314/ai-gateway/releases) 下载对应平台的压缩包
（`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 为 `.tar.gz`，
`windows-x64` 为 `.zip`）。每个压缩包包含 `ai-gateway` 可执行文件、LICENSE、NOTICE、
README.md 和 `config.example.yaml`。

```bash
V=0.2.0 P=linux-x64
curl -LO https://github.com/brokenstring314/ai-gateway/releases/download/v$V/ai-gateway-$V-$P.tar.gz
curl -LO https://github.com/brokenstring314/ai-gateway/releases/download/v$V/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
tar xzf ai-gateway-$V-$P.tar.gz && cd ai-gateway-$V-$P
./ai-gateway serve -c config.yaml     # 可从 config.example.yaml 改起
```

二进制未做代码签名。macOS 上请先清除隔离标记：`xattr -d com.apple.quarantine ./ai-gateway`。

**从源码运行**（需要 [Bun](https://bun.sh/) 1.4.3+）：见下文。

### 从源码运行

```bash
git clone https://github.com/brokenstring314/ai-gateway.git && cd ai-gateway
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
  -e GATEWAY_SECRET_KEY \
  ai-gateway
```

镜像以非 root 用户（uid 1000）在 `tini` 下运行，并设置 `GATEWAY_ENV=production`
（配置必须开启 auth 且至少有一个 key；`adminSecret` 至少 16 个字符）和
`GATEWAY_DATA_DIR=/data`（API key、请求日志和运行时配置库；挂载 volume 以持久化）。生产环境还必须设置
`GATEWAY_SECRET_KEY`（见[运行时配置库](#运行时配置库030)）。配置文件挂载到
`/config/config.yaml`（只读即可）。内置 `HEALTHCHECK` 探测 3000 端口的 `/livez`；
负载均衡 / k8s readiness 请用 `/readyz`。`docker stop` 发送 SIGTERM：`/readyz` 变为 503，
不再接受新连接，进行中的请求在 `SHUTDOWN_GRACE_MS`（默认 10000）内排空。
CI 用 `scripts/docker-smoke.sh <image>` 对镜像做冒烟测试。

---

## CLI 命令参考

```
Usage:
  ai-gateway serve    -c <config.yaml> [-p <port>] [-h <host>]
  ai-gateway validate -c <config.yaml>
  ai-gateway keys create [--admin] [--read-only] [--name <name>] [--expires <ISO>] [--models <a,b>] [--json] -c <config.yaml>
  ai-gateway keys list [--json] -c <config.yaml>
  ai-gateway keys revoke <id> -c <config.yaml>
  ai-gateway config import [--force] -c <config.yaml>
  ai-gateway config status [--json] -c <config.yaml>
  ai-gateway version

Commands:
  serve      Start the gateway server
  validate   Validate a config file and report errors
  keys       Manage the API key store directly (works with the server stopped or running)
  config     Runtime config store: import the file's runtime sections (--force replaces
             stored config), status shows channels (key hints only) and versions
  version    Print version

Options:
  -c, --config <path>   Config file path (YAML or JSON)
  -p, --port <port>     Override server.port
  -h, --host <host>     Override server.host
  --data-dir <dir>      (keys, config) Data directory; default GATEWAY_DATA_DIR or ./.data
```

以上为 `--help`（或 `help`）的实际输出（CLI 只有英文帮助）；`ai-gateway keys --help` 显示 `keys` 的选项；`--version` / `-v` 等同 `version`。`-h` 始终表示 `--host`。未知选项直接报错。

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
  idleTimeoutSeconds: 255   # Bun 空闲超时；0 = 永不超时，最大/默认 255
  sseHeartbeatSeconds: 5    # 流空闲时发送 SSE ": ping" 注释（默认 5）；0 = 关闭
  streamIdleTimeoutSeconds: 120  # 上游这么久没有数据就结束流（默认 120）；0 = 关闭
  streamMaxDurationSeconds: 0    # 单个流的最长时长；0 = 关闭（默认）
  perIpRateLimit:           # /v1/* 按客户端 IP 的令牌桶；rps > 0 才启用（默认关闭）
    rps: 50                 #   每个 IP 每秒请求数（环境变量 RATE_LIMIT_RPS 优先）
    burst: 100              #   桶容量，默认 2 × rps（环境变量 RATE_LIMIT_BURST 优先）

passthroughProxy:
  enabled: false            # 把其他 /v1/* 路由转发到上游（见 API 端点）
  # routes: ["POST /v1/responses", "POST /v1/moderations", "POST /v1/audio/*"]  # 默认白名单

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
    apiKey: "sk-..."                        # 可写成 "${OPENAI_API_KEY}"
    baseURL: "https://api.openai.com/v1"   # 可选，每个 provider 有默认值
    models: ["gpt-4o", "gpt-4o-mini"]
    weight: 3                               # 用于 loadbalance 策略（0 = 摘除）
    retry:                                  # 每个目标的重试（不写 = 只尝试 1 次）
      attempts: 3                           # 最大尝试次数（写了该块时默认 3）
      initialBackoffMs: 100                 # 基础退避时间（默认：100ms）
      onStatusCodes: [408, 429, 500, 502, 503, 504]  # 可重试的状态码（即默认值）
    circuitBreaker:                         # 每个目标的熔断器
      failureThreshold: 5                   # 连续失败多少次后熔断（默认：5）
      successThreshold: 1                   # 半开状态成功多少次后恢复（默认：1）
      maxHalfThreshold: 1                   # 半开状态允许的并发探测数（默认：1）
      timeoutMs: 30000                      # 熔断到半开的超时时间（默认：30000ms）
    concurrency:                            # 每目标并发限制（不设置则关闭）
      maxConcurrency: 20                    # 同时在途的上游调用数（1–10000）
      queueSize: 1000                       # 超出后的等待队列（默认 1000；满了返回 429）

  - name: deepseek-backup
    provider: deepseek
    apiKeys:                                # 多个上游 key（0.3.0；代替 apiKey 或排在它之后）
      - "${DEEPSEEK_KEY_1}"
      - { key: "${DEEPSEEK_KEY_2}", weight: 2, enabled: true }
    keyStrategy: round_robin                # round_robin（默认）| weighted | fill_first
    keyCooldownSeconds: 30                  # 429 且没有 Retry-After 时，该 key 暂停的秒数（默认 30）
    # enabled: false                        # 关闭这个 target（绑定到它的会被跳过）
    models: ["deepseek-chat"]

auth:
  enabled: true             # 除非显式写 false，否则开启
  keys:
    - "sk-my-api-key-1"
    - "sk-my-api-key-2"

adminSecret: "一个安全的管理员密钥至少8个字符"   # 至少 8 个字符（GATEWAY_ENV=production 时至少 16）

cors:
  enabled: true
  origins:
    - "https://my-app.example.com"
    - "http://localhost:3000"
  # allowHeaders: [...]     # 默认反射 Access-Control-Request-Headers

maxRequestBytes: 10485760       # 10 MB 请求体限制（默认）
requestTimeout: "30s"           # 30s（默认）；单位 ms、s、m、h，可组合如 1m30s

aliases:
  fast: "gpt-4o-mini"
  smart: "gpt-4o"

plugins:                        # 按列出顺序执行；各选项见“插件”
  - name: rate-limit
    stage: before_request
    config:
      maxRequestsPerMinute: 60
  - name: word-filter
    stage: before_request
    config:
      blockedWords: ["禁止词", "blocked"]
      mode: reject              # reject（默认）| redact
  - name: max-token
    stage: before_request
    config:
      maxTokens: 4096
  - name: cache
    stage: before_request
    config:
      maxAge: 300
      maxEntries: 1000

compatibility:
  onUnsupportedParam: warn      # warn | drop | reject

mcpServers:
  - name: my-tools
    type: stdio                 # 只支持 stdio 传输
    command: "node"
    args: ["my-mcp-server.js"]
    # env: {...}  inheritEnv: [...]  allowedTools: [...]
    # maxCallDepth: 5  timeoutSeconds: 30  required: false

observability:
  tracing:
    enabled: true
    otlpEndpoint: "http://localhost:4318/v1/traces"   # 完整的 OTLP/HTTP traces URL
    serviceName: "ai-gateway"
    sampleRatio: 1.0            # 0–1（默认 1.0）
    privacyLevel: metadata      # none | metadata（默认）| full
    # headers: {...}  shutdownGrace: "10s"
  metrics:
    enabled: true
    port: 9090
```

### 运行时配置库（0.3.0）

配置分两层：

- **启动配置** —— `server`、`auth`、`adminSecret`、`cors`、`observability`、`mcpServers`、`requestTimeout`、`maxRequestBytes`、`passthroughProxy` —— 始终来自配置文件，修改需要重启。
- **运行时资源** —— `targets`（渠道）、`strategy`、`aliases`、`plugins`、`compatibility` —— 默认存放在 `<数据目录>/config.sqlite`（`runtimeConfig.source: database`），这样 0.3.0 的管理 API 和控制台可以不重启就修改它们。

库为空时首次启动，会把配置文件里的运行时段落导入一次（日志 `[config] imported N target(s)…`，记为配置版本 1）。之后以库为准：配置文件的运行时段落再有改动，启动时会警告这些改动**被忽略**。要用文件覆盖库中配置，执行 `ai-gateway config import --force -c config.yaml` 后重启。`ai-gateway config status -c config.yaml` 查看渠道（只显示 key 尾号）和最近的版本。

上游 key 永不以明文入库：

- 字面量 `apiKey` 用 AES-256-GCM 加密，密钥由 **`GATEWAY_SECRET_KEY`** 经 HKDF-SHA256 派生，并绑定所属渠道（密文拷到别的行无法解密）。用 `openssl rand -base64 32` 生成主密钥（base64 或 hex，至少 32 字节）并妥善保管：丢失后已存的 key 无法解密。没有主密钥时启动会拒绝存取加密 key；`GATEWAY_ENV=production` 下没有主密钥直接拒绝启动。
- 只是环境变量引用的 `apiKey`（`"${OPENAI_API_KEY}"`）按引用原样存储，使用时从环境变量解析，与以前一致，不需要主密钥。
- 列表、日志、配置版本和审计日志里只显示 `sk-…abcd` 这样的尾号。
- 更换主密钥：新密钥设为 `GATEWAY_SECRET_KEY`，旧密钥放进 `GATEWAY_SECRET_KEY_PREVIOUS`（多个用逗号分隔），两者都能解密。

每次变更都是一个 SQLite 事务，同时写入配置版本（完整快照，key 只存密文）和审计记录。表结构迁移前会把现有库复制为 `config.sqlite.pre-migration-<时间>.bak`，迁移失败则拒绝启动。库文件和备份都以仅属主可读写（`0600`）创建。

运行时资源通过[运行时配置管理 API](#运行时配置管理-api030)在线修改（渠道、key、模型、设置、版本与回滚）。每次修改在切换前都按启动时的规则完整校验（不通过则什么都不改：`422`），并且每次修改前用 `VACUUM INTO` 备份数据库（`config.sqlite.backup-<时间>.bak`，保留最近 5 份；`CONFIG_BACKUP_MIN_INTERVAL_MS` 可拉开间隔）。

偏好 GitOps 的部署可设 `runtimeConfig: { source: file }`，保持 0.2.0 行为：只以文件为准、不入库、运行时配置只读（管理 API 的写操作返回 `403 config_read_only`）。

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
| `GATEWAY_SECRET_KEY` | 未设置 | 加密运行时配置库中上游 key 的主密钥（≥ 32 字节随机数，base64 或 hex；`openssl rand -base64 32`）。存取字面量上游 key 时必需；`GATEWAY_ENV=production` 且使用数据库来源时始终必需。见[运行时配置库](#运行时配置库030)。 |
| `GATEWAY_SECRET_KEY_PREVIOUS` | 未设置 | 更换主密钥后仍可用于解密的旧密钥，多个用逗号分隔。 |
| `CONFIG_BACKUP_MIN_INTERVAL_MS` | `0` | 管理 API 修改前备份配置库的最小间隔（0 = 每次修改前都备份；保留最近 5 份）。 |
| `GATEWAY_ENV` | 未设置 | 设为 `production` 时启用启动安全检查：拒绝 `auth.enabled: false`、`ALLOW_UNAUTHENTICATED_PROXY=true`、少于 16 个字符的 `adminSecret`，以及完全没有客户端密钥（无 `auth.keys` 且密钥库为空）时启动。 |
| `ADMIN_BOOTSTRAP_KEY` | 未设置 | 首次启动用的管理员凭据；一旦存在真正的管理员凭据即被拒绝，创建过 admin 密钥后永久拒绝（见[密钥作用域](#密钥作用域密钥库模式)）。 |
| `ADMIN_BOOTSTRAP_READ_ONLY_KEY` | 未设置 | 同上，`read_only` 权限。 |
| `ALLOW_UNAUTHENTICATED_PROXY` | `false` | `true` 时允许可选的透传代理在没有客户端密钥时转发。`GATEWAY_ENV=production` 下被拒绝。 |
| `RATE_LIMIT_RPS` | 未设置（限流关闭） | `/v1/*` 按客户端 IP 的每秒请求数，优先于 `server.perIpRateLimit.rps`；`0` 表示关闭。 |
| `RATE_LIMIT_BURST` | 2 × rps | 每个 IP 的桶容量，优先于 `server.perIpRateLimit.burst`。 |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | 逗号分隔的 IP/CIDR，来自这些地址的 `X-Forwarded-For` / `X-Real-IP` 才被按 IP 限流信任。部署在负载均衡后面时请设为 LB 的地址段，否则所有请求共享 LB 的 IP。 |
| `SHUTDOWN_GRACE_MS` | `10000` | 收到 SIGTERM/SIGINT 后等待在途请求完成的时间（毫秒）。关闭顺序：`/readyz` 立即返回 503，已有连接上的新请求返回 503 `shutting_down`；监听器停止接受新连接；等待在途请求完成，包括仍在写出的 SSE / 流式响应体（响应带 `Connection: close`）；最后关闭监听器和存储。 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 未设置 | 未配置 `observability.tracing.otlpEndpoint` 时使用的 OTLP HTTP 端点。 |
| `OTEL_TRACES_SAMPLER` | 未设置 | `always_on`、`always_off` 或 `traceidratio`（使用 `sampleRatio`）；其他值被忽略。 |

**按 IP 限流**默认关闭。网关直接暴露在公网时，用 `server.perIpRateLimit`（或 `RATE_LIMIT_RPS`）开启；在负载均衡后面时还要设置 `TRUSTED_PROXIES`。超限请求返回 `429`、`{"error": {"code": "rate_limited", ...}}` 和 `Retry-After` 头（秒）。限流桶按进程计算，空闲的桶会被清理。

**数据目录（`GATEWAY_DATA_DIR`，默认 `./.data`）** 包含：

- `api-keys.sqlite` — API 密钥库：密钥的 SHA-256 哈希（不存明文）、显示前缀、名称、权限、过期时间和使用计数。丢失它等于吊销所有密钥库中的密钥；能写入它的人就能伪造密钥，请保持私有（目录 `chmod 700`）。
- `request-logs.sqlite` — `/admin/logs` 使用的请求日志：trace id、模型、提供商、token 数和错误信息（不含提示词和回复）。错误信息可能引用上游响应内容。以 WAL 模式打开（`synchronous=NORMAL`，1 秒 busy timeout）。
- `config.sqlite` — 运行时配置库（渠道、加密的上游 key、路由设置、配置版本、审计日志），见[运行时配置库](#运行时配置库030)。`config.sqlite.pre-migration-*.bak` 是迁移前的自动备份。
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

任何未知的提供商，只要提供了 `baseURL`，就会被当作通用 OpenAI 兼容端点处理；未知提供商且没有 `baseURL` 会让 `validate` 和启动报错。提供商名不区分大小写；`nvidia-nim`、`nim` 是 `nvidia_nim` 的别名，`x-ai` 是 `xai` 的别名，`dashscope` 是 `qwen` 的别名。`openrouter` 目标会发送 `HTTP-Referer` / `X-Title` 归属头。`baseURL` 可以包含 `${VAR}` 引用（如 `"${OPENAI_BASE_URL}"`、`"http://localhost:${PORT}/v1"`），展开后必须是 http(s) URL。

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
- 网关不建模的字段按白名单双向透传。请求：`reasoning_effort`、`verbosity`、`store`、`metadata`、`modalities`、`audio`、`prediction`、`service_tier`、`web_search_options`、`prompt_cache_key`、`safety_identifier` 以及常见厂商参数（`top_k`、`min_p`、`repetition_penalty`、`reasoning`、`thinking`、`enable_thinking`、`chat_template_kwargs`、Perplexity 的 `search_*` / `return_*`）；消息上的 `reasoning_content` / `reasoning` / `refusal` / `audio` / `prefix`。响应与流式 chunk：`system_fingerprint`、`service_tier`、`citations`、`search_results`；`choices[].logprobs`；message / delta 上的 `reasoning_content`、`reasoning`、`refusal`、`annotations`、`audio`；usage 的 `prompt_tokens_details`、`completion_tokens_details`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`。其他未知字段仍会丢弃（0.3.0 起也包括上游的 `cost` / `cost_details`：网关不再携带任何金额字段）。
- 显式传 `null` 的可选参数（`"temperature": null`、`"tools": null` 等）视为未设置，与 OpenAI API 一致

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

返回调用者的 key 可用的已发布模型和别名，见[发布的模型](#发布的模型030)：

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

开启后，请求会先运行 **before-request 插件**（限流、key 的 RPM、对 `messages` / `input` / `prompt` / `instructions` 的敏感词过滤；max-token 作用于 `max_output_tokens` / `max_tokens` / `max_completion_tokens`，`/v1/responses` 未设置时注入 `max_output_tokens`），再按 `X-Provider` 头或请求体顶层 `model` 原样转发。由于请求体结构未知，需要改写内容的插件（word-filter `redact`）或短路会直接返回 403；被封顶的 token 上限会写入转发的请求体。透传请求**没有**熔断、回退、after-request 插件和 token 计量，因此默认关闭。设了 token 额度的 key 在透传路由上会被拒绝（403 `quota_not_metered`）：它们的 token 无法计量。

### 健康探针

| 端点            | 用途                           | 状态码       |
| ------------- | ---------------------------- | --------- |
| `GET /health` | 通用健康检查                       | 200       |
| `GET /livez`  | 进程存活（Kubernetes liveness 探针）。仅当某个 `required` MCP 服务器连续 5 次重连失败时返回 503，让编排系统重启 Pod | 200 / 503 |
| `GET /readyz` | 就绪检查：配置和提供商已加载、SQLite 存储（密钥库、请求日志库）可访问、必需的 MCP 服务器可用、未处于排空状态。上游熔断器状态**不**影响就绪（所有副本共享同一上游，否则会把整个集群同时摘除），仅在响应体中以 `circuitBreakers` / `upstreamAvailable` 报告。收到 SIGTERM/SIGINT 开始排空后立即返回 503，排空期间新请求返回 503 | 200 / 503 |

### 指标

```
GET /metrics
```

Prometheus 格式的指标，包括：

- `ai_gateway_requests_total{method, status, provider}` — HTTP 请求计数
- `ai_gateway_request_duration_seconds{method, status, provider}` — 延迟直方图
- `ai_gateway_tokens_input_total{provider, model}` — 输入 token 计数（所有带 usage 的 surface）
- `ai_gateway_tokens_output_total{provider, model}` — 输出 token 计数
- `ai_gateway_plugin_blocked_total{plugin, outcome, surface}` — 被插件结束的请求

完整列表见 [Prometheus 指标](#prometheus-指标)。

### 管理 API

密钥库模式（`ai-gateway serve`）下，管理端点接受：`adminSecret`（`X-Admin-Secret` 或 `Authorization: Bearer`）、密钥库中 `admin` 或 `read_only` 作用域的密钥（`Authorization: Bearer`），以及仍被允许时的 bootstrap 密钥（见下文）。仅 inference 作用域的密钥返回 403 `insufficient_scope`；所有写操作需要 `admin`。没有密钥库时（嵌入式 `createApp(gateway, config)`）只接受 `adminSecret`，未配置 `adminSecret` 时管理 API 返回 403 `admin_disabled`。

| 方法     | 路径                        | 作用域       | 说明                |
| ------ | ------------------------- | --------- | ----------------- |
| GET    | `/admin/config`           | read_only | 获取当前配置（已脱敏：API 密钥、admin secret、客户端密钥、URL 中的凭据、OTLP 头、MCP env/args、插件配置里疑似密钥的字段；完整的 `${VAR}` 模板原样显示） |
| GET    | `/admin/keys`             | read_only | 列出 API 密钥（不返回明文） |
| GET    | `/admin/keys/usage`       | read_only | 使用计数：`totalKeys`、`totalUsageCount`、每个密钥的 `usageCount`、`usedTokens`、`quotaTokens` |
| GET    | `/admin/keys/:id`         | read_only | 单个密钥，含限额与已用 token；`ETag` = 其 revision |
| POST   | `/admin/keys`             | admin     | 创建密钥（`{"name", "scopes"?, "expiresAt"?, "allowedModels"?, "quotaTokens"?, "rpm"?, "tpm"?}`），密钥只返回一次 |
| PUT    | `/admin/keys/:id`         | admin     | 修改名称和作用域（`{"name", "scopes"}`） |
| PATCH  | `/admin/keys/:id`         | admin     | 修改名称、作用域、可用模型、过期时间、`quotaTokens`、`rpm`、`tpm`（必须带 `If-Match`） |
| POST   | `/admin/keys/:id/reset-usage` | admin | 已用 token 清零（`If-Match` 可选） |
| GET    | `/admin/usage`            | read_only | 按 `key`、`model` 或 `channel` 汇总一段日期内的 token / 请求数 / 错误数 / 延迟 |
| POST   | `/admin/keys/:id/revoke`  | admin     | 吊销密钥 |
| POST   | `/admin/keys/:id/rotate`  | admin     | 轮换密钥（新密钥只返回一次） |
| DELETE | `/admin/keys/:id`         | admin     | 删除密钥 |
| GET    | `/admin/logs`             | read_only | 请求日志（新的在前）；`limit`（≤200）、`offset`，过滤 `stage`（surface）、`model`、`provider`（target）、`since`、`status=error\|ok` |
| GET    | `/admin/logs/stats`       | read_only | 按 surface/target/model 计数、错误数、token（同样的过滤） |
| DELETE | `/admin/logs?before=<ISO>`| admin     | 删除 `before` 之前的持久化日志（可选 `stage` / `model` / `provider`） |
| GET    | `/admin/status`           | read_only | 控制台概览：调用方 `scopes`、各 target 的 `circuitBreakers`、`upstreamAvailable`、`mcpServers`、本进程请求摘要（数量、4xx/5xx、错误率、延迟 mean/p50/p95） |
| POST   | `/admin/session/login`    | —（公开，有限流） | 控制台登录：`{ "key" }` → HttpOnly 会话 Cookie + CSRF token（见[管理控制台](#管理控制台)） |
| GET / DELETE | `/admin/sessions`、`/admin/sessions/:id` | read_only / admin | 列出 / 吊销控制台会话；`POST /admin/session/logout` 退出自己的会话 |
| GET    | `/admin/channels/:id/balance` | read_only | 上游账户余额（DeepSeek、OpenRouter），仅供参考，不保存 |

没有密钥库时，`GET` / `POST` / `DELETE /admin/keys` 管理的是内存中的 `auth.keys` 列表（`POST {"key": "sk-..."}`，按列表下标删除；重启后丢失）。

`GET /admin/config` 显示当前生效的配置（包含运行时修改）。0.2.0 时代的整份配置接口（`PUT`/`DELETE /admin/config`、`/admin/config/reload`、`/admin/config/history`、`/admin/config/rollback/:v`）仍返回 `410 config_api_removed`；运行时资源通过下面的资源 API 修改。启动配置仍然要改文件并重启。收到 `SIGHUP` 只打日志，不做任何事。

#### 运行时配置管理 API（0.3.0）

| 方法 | 路径 | 作用域 | 说明 |
| ---- | ---- | ------ | ---- |
| GET / POST | `/admin/channels` | read_only / admin | 列出 / 新建渠道（上游 target）及其 key（只显示尾号） |
| GET / PATCH / DELETE | `/admin/channels/:id` | read_only / admin | 单个渠道 |
| POST | `/admin/channels/:id/keys` | admin | 添加上游 key（加密存储） |
| PATCH / DELETE | `/admin/channels/:id/keys/:keyId` | admin | 改权重 / 启停、删除；另有 `POST …/enable`、`…/disable` |
| POST | `/admin/channels/:id/test`、`/fetch-models` | admin | 探测上游（限流、10 秒超时、2 MiB 上限、不跟随重定向） |
| GET / POST | `/admin/models` | read_only / admin | 已发布模型（含绑定、`available`） |
| GET / PATCH / DELETE | `/admin/models/:id` | read_only / admin | 单个模型（`PATCH` 也可带 `bindings`：字段和绑定在同一事务里一起生效或一起失败） |
| PUT | `/admin/models/:id/bindings` | admin | 整体替换绑定（渠道、上游模型名、优先级、权重、启停、参数） |
| GET / PATCH | `/admin/settings` | read_only / admin | 全局策略、别名、插件、兼容性、`modelSource` |
| GET | `/admin/config/versions`、`/admin/config/versions/:v` | read_only | 配置历史（快照不含 key 材料） |
| POST | `/admin/config/versions/:v/rollback` | admin | 把版本 `v` 恢复为一个新版本 |
| GET | `/admin/audit` | read_only | 谁在何时改了什么（从不含密钥） |
| GET | `/admin/presets` | read_only | 提供商预设与已知模型 |

所有写操作：JSON 请求体严格校验（未知字段 → 400）、需要 `admin` 作用域、CSRF 防护（跨站 `Origin` / `Sec-Fetch-Site` → 403，非 JSON 请求体 → 415）、必须带 `If-Match`（资源的 revision，即 `ETag`；缺少 → 428，过期 → 409）、在一个事务里写入变更、配置版本和审计记录并切换到新运行时（结果不合法 → `422 config_invalid`，什么都不改，进行中的请求不受影响）。上游 key 永不返回。通过这里写入的 base URL 必须是**公网地址**（回环、内网、链路本地/云元数据、CGNAT、对应的 IPv6 地址以及解析到它们的域名都会被拒绝，并且每次请求上游前都会重新检查以防 DNS 重绑定）；Ollama 等本地服务可以写在配置文件里。完整说明（英文）：[docs/admin-api.md](docs/admin-api.md)。

```bash
# 添加一个带两个 key 的渠道，再在上面发布一个模型
curl -X POST -H "X-Admin-Secret: $S" -H "Content-Type: application/json" http://localhost:3000/admin/channels \
  -d '{"name":"ds","preset":"deepseek","keys":[{"key":"sk-…1"},{"key":"sk-…2"}],"keyStrategy":"round_robin"}'
curl -X POST -H "X-Admin-Secret: $S" -H "Content-Type: application/json" http://localhost:3000/admin/models \
  -d '{"name":"ds-chat","balance":"round_robin","bindings":[{"channel":"ds","upstreamModel":"deepseek-v4-flash"}]}'
# 修改：先读 ETag，再作为 If-Match 带回
curl -i -H "X-Admin-Secret: $S" http://localhost:3000/admin/channels/<id>        # ETag: "12"
curl -X PATCH -H "X-Admin-Secret: $S" -H 'If-Match: "12"' -H "Content-Type: application/json" \
  -d '{"enabled":false}' http://localhost:3000/admin/channels/<id>
```

**示例：**

```bash
# 获取配置
curl -H "X-Admin-Secret: my-secret" http://localhost:3000/admin/config

# 创建一个 inference 密钥（密钥库模式）；响应中密钥只出现一次
curl -X POST \
  -H "X-Admin-Secret: my-secret" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "scopes": ["inference"]}' \
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

可选：`--expires 2027-01-01T00:00:00Z`、`--read-only`（代替 `--admin`；都不指定则为 `inference`）、`--models a,b`、`--quota-tokens N`、`--rpm N`、`--tpm N`（见下文）。该命令会校验配置，但不会打印配置或除新密钥以外的任何秘密；数据目录下没有密钥库时直接报错（不会新建），所以数据目录写错会立即暴露。Docker 中：`docker exec <容器> bun src/index.ts keys create --admin -c /config/config.yaml`（镜像已设置 `GATEWAY_DATA_DIR=/data`）。

#### key 额度与用量（0.3.0）

本网关只有一个所有者/管理员，不是收费的 API 服务：没有价格、费用、金额额度、支付或用户账号。把 key 分给别人时，可以按 **token** 和 **请求数** 限制：

| 字段 | 含义 | `null` / 不设置 |
| ---- | ---- | --------------- |
| `quotaTokens` | 该 key 在被重置之前总共可用的 token（prompt + completion，以上游返回的 usage 为准；流式请求总是向上游要 usage，只有上游确实不给时才估算） | 不限 |
| `rpm` | 该 key 自己的每分钟请求数 | `rate-limit` 插件的 `maxRequestsPerMinute`（如有） |
| `tpm` | 该 key 自己的每分钟 token 数（请求结束时计入） | `rate-limit` 插件的 `maxTokensPerMinute`（如有） |
| `allowedModels`、`expiresAt` | 可用的对外模型；过期时间 | 全部模型；永不过期 |

创建时设置（`POST /admin/keys`，或 `ai-gateway keys create --quota-tokens N --rpm N --tpm N`），之后用 `PATCH /admin/keys/:id` 修改（`If-Match: "<revision>"`，取自 `GET /admin/keys/:id` 的 ETag；`null` 表示清除该限额）。配置文件 `auth.keys` 里的 key 属于所有者，没有自己的限额（适用插件的值）。

**额度语义。** key 的已用 token 达到额度后，新请求在开始前即被拒绝：**403 `quota_exhausted`**（type `insufficient_quota`；用 403 而不是 429，因为等待没有用——额度不会自动恢复）。已经放行的请求**一定完整结束**，流不会因为额度被中途切断；其 token 在结束时计入，所以最后一个请求（以及当时已在进行中的请求）可能让 key 超出额度。调高额度（`PATCH`）或 `POST /admin/keys/:id/reset-usage` 后可继续使用。图片生成和透传路由无法按 token 计量，因此设了额度的 key 在这些路由上返回 **403 `quota_not_metered`**。RPM / TPM 超限返回 **429 `rate_limit_exceeded`** 并带 `Retry-After`。

**性能。** 额度、RPM、TPM 只检查内存计数器：请求路径上不读也不写数据库。已用 token 大约每秒（以及关闭时）异步写回密钥库，启动时恢复；在线改配置（重载）不会清零任何计数。进程崩溃最多丢失约 1 秒的计量。

**用量统计。** 每个结束的请求（包括被拒绝的，计为错误）都会累加到 `<数据目录>/usage.sqlite` 的按小时汇总表（批量写入、WAL）：请求数、错误数、输入 / 输出 / 缓存命中 / 推理 token、延迟，按 key × 模型 × 渠道。`GET /admin/usage?groupBy=key|model|channel&from=YYYY-MM-DD&to=YYYY-MM-DD[&tz=Asia/Shanghai][&daily=true]`（`read_only` 即可）按需汇总；日期是 `tz` 时区（默认 UTC）里的自然日，存储按整点 UTC 小时分桶，因此半小时偏移的时区精确到小时；单次最多 366 天，默认最近 7 天。每个 key 的响应里还带 `usedTokens`、`remainingTokens`、`quotaExhausted`、`usageResetAt`。详见 [docs/admin-api.md](docs/admin-api.md#key-limits-and-usage)。

```bash
# 给朋友 200 万 token、每分钟 20 次、只能用 ds-chat
curl -X POST -H "X-Admin-Secret: $S" -H "Content-Type: application/json" http://localhost:3000/admin/keys \
  -d '{"name":"friend","allowedModels":["ds-chat"],"quotaTokens":2000000,"rpm":20}'
curl -H "X-Admin-Secret: $S" "http://localhost:3000/admin/usage?groupBy=key&tz=Asia/Shanghai"
curl -X POST -H "X-Admin-Secret: $S" http://localhost:3000/admin/keys/<id>/reset-usage
```

### 管理控制台

内置 Web 控制台，地址 **`/admin/dashboard`**（0.3.0）：用 Preact + Vite 构建的单页应用，构建时嵌入服务端
（`src/dashboard/assets.generated.ts`），所以 `bun build --compile` 二进制和 Docker 镜像不需要磁盘上的文件，服务端也没有新增运行时依赖。
界面支持中文 / English（右上角切换；默认跟随浏览器语言，选择记在 `localStorage`）。

| 页面 | 能做什么 | Admin API |
| ---- | -------- | --------- |
| 概览 | 近 14 天每日请求 / token / 错误、错误率、上游可用性、渠道健康（熔断器、key 状态） | `/admin/status`、`/admin/usage`、`/admin/channels` |
| 渠道 | 列表：状态、测试延迟、key 状态（正常 / 冷却中 / 已停用）、**上游账户余额**（DeepSeek、OpenRouter 支持，其他显示“—”）；新增向导：选预设 → 填 key → 测试 → 拉模型 → 勾选发布；编辑、增删 / 启停 key、权重、多 key 策略、429 冷却 | `/admin/channels…`、`/admin/channels/:id/balance` |
| 模型 | 表格 + 编辑抽屉：元数据（上下文、最大输出、输入类型、结构化输出、工具、联网、系统 / developer 角色、推理）、绑定渠道拖拽排序优先级组、权重、组内均衡、路由策略 | `/admin/models…` |
| 密钥 | 创建时选可用模型、token 额度、RPM / TPM、过期时间（明文只显示一次，可复制）；用量与额度、调整限额、用量清零、吊销 | `/admin/keys…` |
| 用量 | 按密钥 / 模型 / 渠道看 token、请求、错误；日期范围、时区；图表和合计 | `/admin/usage` |
| 日志 | 请求日志，过滤、分页 | `/admin/logs` |
| Playground | 通过真实路由（绑定、元数据校验、故障转移）调用任意已发布模型，可流式；用量记为 `console-playground` | `/admin/playground/chat/completions` |
| 设置 | 别名、全局每 key 限流、插件（JSON）、模型来源；控制台会话（列出 / 吊销） | `/admin/settings`、`/admin/sessions` |
| 版本与审计 | 配置版本、版本间差异、回滚；审计日志 | `/admin/config/versions…`、`/admin/audit` |

每次保存显示 **“已生效 · 版本 #N”**；校验错误显示在对应字段旁；写入时版本已过期（`409`）提示“已被修改，请刷新”。所有写操作都带 `If-Match`。

**登录（会话，计划 §9.4）**：输入 `admin` 或 `read_only` 密钥（或 `adminSecret`），控制台只用它换一次服务端会话
（`POST /admin/session/login`），**浏览器不保存密钥**：会话放在 `HttpOnly; SameSite=Strict; Path=/admin` Cookie 中（https 或代理发送
`X-Forwarded-Proto: https` 时加 `Secure`），有效期 12 小时、空闲 60 分钟超时；所有用 Cookie 认证的写请求必须带双提交 CSRF token
（`X-CSRF-Token`，与第二个 Cookie 和会话中保存的值比对）。同一客户端 IP 连续登录失败 5 次锁定 15 分钟（`429` + `Retry-After`；
在反向代理后面请设置 `TRUSTED_PROXIES`，以便取到真实客户端 IP）。会话只存在进程内存中（重启后需重新登录），与 `/v1/*` 无关。
用密钥库 key 登录的会话在该 key 被吊销、过期或失去权限时立即失效。可调参数：

```yaml
console:
  sessionTtlMinutes: 720     # 会话最长有效期
  idleTimeoutMinutes: 60     # 空闲超时
  maxLoginFailures: 5        # 每个客户端 IP，超过即锁定
  lockoutMinutes: 15
  secureCookie: auto         # auto | always | never
```

用 Bearer / `X-Admin-Secret` 调 Admin API 的方式不变。页面和带哈希的静态资源不含数据，无需认证，均带严格 CSP（`default-src 'none';
script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`，无内联脚本、无 eval、无第三方来源）以及
`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cross-Origin-Opener-Policy: same-origin`、`Permissions-Policy`，https 下加 HSTS。
`/admin` 跳转到控制台；0.2 的 `/admin/static/*` 已删除。与其他管理 API 一样，`/admin/*` 只应暴露在可信网络中。

**构建控制台**（开发者）：`bun run console:build`（Vite → `console/dist` → 生成内嵌文件，该文件提交进仓库，CI 检查是否过期）、
`bun run console:dev`（Vite 开发服务器，把 `/admin` 代理到 :3000 的网关）、`bun run console:typecheck`。

### 响应头

网关在响应中添加以下头：

| 头                        | 说明                                |
| ------------------------ | --------------------------------- |
| `X-Gateway-Provider`     | 处理请求的目标名称（流式与 `/v1/completions` 同样设置） |
| `X-Gateway-Target`       | 仅错误响应：产生错误的目标（不会出现在响应体中） |
| `X-Gateway-Overhead-Ms`  | 网关拿到响应所用的毫秒数，包含上游调用（流式：到第一个分块的时间） |
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
| `rate-limit` 插件拒绝 | 429 + `Retry-After` | `plugin_rejected` |
| key 的 token 额度用完 | 403 | `quota_exhausted` |
| 有额度的 key 调用图片 / 透传路由 | 403 | `quota_not_metered` |
| key 自己的 RPM / TPM（或插件的 TPM）超限 | 429 + `Retry-After` | `rate_limit_exceeded` |
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
| `cost_optimized`（及 `unpricedStrategy`）      | `fallback`，targets 按偏好顺序排列                             |
| `content_based`（及 `keywords`、`contentConditions`） | `conditional` + `field: prompt` 规则（`contains` 或 `pattern`） |
| `abtest`（及 `abVariants`）                    | `loadbalance` + `weights`。`abtest` 暂时作为 `loadbalance` 的废弃别名保留（启动时告警），0.3.0 移除 |
| `strategy.conditions`（Go 的 `key/value/target_key`） | `strategy.rules: [{ field, pattern, target }]`  |

---

## 弹性机制

### 指数退避重试

为每个目标配置重试行为（适用于所有策略，包括 `single`）。退避使用指数抖动：`延迟 = random(0, initialBackoffMs × 2^(尝试次数-1))`。

```yaml
targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    retry:
      attempts: 3
      initialBackoffMs: 100
      onStatusCodes: [408, 429, 500, 502, 503, 504]  # 默认值
```

没有 `retry` 块的目标只尝试 1 次；写了该块时 `attempts` 默认 3。

- **4xx 错误（429 除外）不在同一目标上重试**。401/403/404 仍会切换到下一个目标（见 Fallback）；其他 4xx 表示客户端问题
- `onStatusCodes` 中的 **408、429 和 5xx** 会退避重试
- **网络错误** 会重试
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
- **打开**：该目标被跳过（failover 到下一个候选）；所有候选都打开时返回 503 `circuit_open` 并带 `Retry-After`。
- **半开**：最多允许 `maxHalfThreshold`（默认 1）个探测请求。成功 `successThreshold` 次后关闭熔断器，失败则重新打开。
- 结算基于 permit：一次结果只在其请求被放行时的熔断器“代”内生效。客户端中止、以及始终没离开并发队列的请求都不计入。

### 并发限制

```yaml
targets:
  - name: openai-main
    provider: openai
    apiKey: "sk-..."
    concurrency:
      maxConcurrency: 20   # 该目标同时在途的上游调用数
      queueSize: 1000      # 等待中的请求数（默认 1000）
```

不设置 `maxConcurrency` 就不启用。请求在该目标的队列里等待槽位；队列已满或等待期间到达请求截止时间时，该候选以 429 `gateway_overloaded` 失败（仍会 failover 到下一个候选），且不计入熔断器。

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
      maxRequestsPerMinute: 60  # 每个 key（别名：keyRpm、rpm）；key 自己的 rpm 优先
      maxRequestsPerDay: 5000   # 可选（别名：rpd）；不设置时不跟踪日窗口
      maxTokensPerMinute: 100000 # 可选（别名：tpm）；每个 key，key 自己的 tpm 优先
      key: shared               # 可选，没有 API 密钥的请求使用的桶名（默认："default"）
```

窗口从该密钥的第一个请求开始计时，60 秒 / 24 小时后重置，因此跨越窗口边界的突发最多可放行两倍限额。限额按进程计算（多副本之间不共享）。被拒绝时返回 429 `plugin_rejected`，并带 `Retry-After`（距窗口重置的秒数）。三个限额至少设置一个。设了自己 `rpm` / `tpm` 的 key 改用自己的值（见 [key 额度与用量](#key-额度与用量030)）；`maxTokensPerMinute` 由同一个内存 key 计量器执行（请求结束时计入 token，超限 429 `rate_limit_exceeded`）。

#### 响应缓存（Cache）

LRU 缓存，键基于所有有意义的请求参数（model、messages、temperature、tools、seed、maxTokens 等）。

```yaml
plugins:
  - name: cache
    stage: before_request
    config:
      maxAge: 300               # 缓存 TTL（秒，别名：ttlSeconds；默认：300）
      maxEntries: 1000          # 最大缓存条目数（别名：maxSize；默认：1000）
```

#### 词过滤（Word Filter）

内容安全护栏，拒绝（或脱敏）包含屏蔽词的请求。

```yaml
plugins:
  - name: word-filter
    stage: before_request
    config:
      blockedWords: ["禁止词", "有害内容"]   # 别名 blocklist；列表为空则跳过该插件
      mode: reject                         # reject（默认，403 plugin_rejected）| redact
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

限制每个请求的输出 token 上限。

```yaml
plugins:
  - name: max-token
    stage: before_request
    config:
      maxTokens: 4096           # 必填。封顶 max_tokens / max_completion_tokens；两者都没设置时注入为 max_tokens
```

#### 预算控制（Budget，0.3.0 已删除）

网关不再给请求定价。`plugins` 里出现 `budget`（无论是否启用）都会校验失败并给出提示；请改用按 token 限制 key（[key 额度与用量](#key-额度与用量030)）。

#### 日志（Logger，0.2.0 已移除）

`logger` 插件与网关自带的请求日志（每个请求一行 JSON，见“结构化日志”）重复。`plugins` 里的 `logger` 条目会被忽略并在启动时告警，请删除。

### 插件配置与错误策略

- 条目按列出顺序执行。schema 要求填写 `stage`，但每个内置插件会自行注册到所需阶段：`cache` 同时注册 `before_request` 与 `after_request`，`pii-secret-guard` 取决于 `direction`，其余为 `before_request`。`type` 可选，仅作说明。`enabled: false` 跳过该条目；名称里的 `-` 可写成 `_`。未知插件名会被忽略并告警。
- **每个内置插件的 `config` 都做严格校验**（`ai-gateway validate` 与启动时）：未知键（附“是否想写”提示）、类型错误、缺少必填项（`rate-limit` 需要 `maxRequestsPerMinute` / `maxRequestsPerDay` / `maxTokensPerMinute` 之一，`max-token` 需要 `maxTokens`）、`word-filter` 的 `mode` 不是 `reject` / `redact`，以及同一选项的两个别名同时设置（如 `maxAge` 与 `ttlSeconds`）都会报错。只接受上面各插件示例中的键（及列出的别名）；计数类字段（`maxRequestsPerMinute`、`maxRequestsPerDay`、`maxTokensPerMinute`、`maxEntries`、`maxTokens`）必须是整数。
- **所有插件的错误都是故障关闭（fail-closed）：** 插件抛异常时请求失败（500 `Internal server error`，并随请求记录日志）。没有 fail-open 模式。

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

- 每个服务器的选项：`timeoutSeconds` 单次工具调用超时（默认 30），`maxCallDepth`（agentic 循环由所有服务器共享，因此取各服务器所设 `maxCallDepth` 中的**最小值**；未设置的服务器不参与；都未设置时默认 5；超出返回 502 `mcp_depth_exceeded`），`allowedTools`（只暴露这些工具），`required`（影响 `/readyz` / `/livez`，见下文）
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
    otlpEndpoint: "http://localhost:4318/v1/traces"   # 或环境变量 OTEL_EXPORTER_OTLP_ENDPOINT
    serviceName: "ai-gateway"
    sampleRatio: 1.0          # 或环境变量 OTEL_TRACES_SAMPLER
    privacyLevel: metadata    # none | metadata | full
    headers: {}               # 例如 collector 的认证头（/admin/config 中会脱敏）
    shutdownGrace: "10s"      # 关闭时的 flush 时间
```

Span 通过 **OTLP/HTTP** 原样发送到 `otlpEndpoint`（请写完整的 `/v1/traces` URL）。只实现了 HTTP exporter：`otlpProtocol` 可省略或设为 `http`；`otlpProtocol: grpc` 会导致配置校验失败（请把 `otlpEndpoint` 指向 collector 的 OTLP/HTTP 端口，通常是 4318）。未设置 `enabled: true` 或没有端点时不启用追踪。

每个请求一个根 span（带 `request.model` 属性，错误记录在其上）：

- `gateway.route`（非流式 chat）、`gateway.routeStream`（流式 chat）
- `gateway.completions`、`gateway.completions_stream`、`gateway.embedding`、`gateway.image`、`gateway.passthrough`

没有按插件或按 MCP 调用的子 span。

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
| `ai_gateway_provider_errors_total` | counter | `provider`, `error_type`（每次失败的上游尝试，含已 failover 的） |
| `ai_gateway_circuit_breaker_state` | gauge   | `provider`, `state`（当前状态为 1） |
| `ai_gateway_mcp_server_up`       | gauge     | `server` |
| `ai_gateway_rate_limit_rejections_total` | counter | `provider`（`none`：`rate-limit` 插件的拒绝） |
| `ai_gateway_plugin_blocked_total` | counter  | `plugin`, `outcome`（`plugin_rejected`、`plugin_short_circuit`、`response_rejected`）, `surface` |
| `ai_gateway_guardrail_detections_total` | counter | `entity`, `category`, `action`, `direction` |

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
  "surface": "chat",
  "publishedModel": "gpt-4o",
  "keyId": "3f2a…",
  "tokens": {"prompt": 15, "completion": 8, "total": 23, "cacheHit": 4, "reasoning": 2},
  "status": 200
}
```

`keyId` 是客户端 key 的 id（密钥库 id，或 `cfg_<n>` 表示 `auth.keys` 中第 n 个条目，从 0 起），绝不是 key 本身；`publishedModel` 是客户端请求的对外模型（已解析别名）。可选字段：`error`、`usageEstimated`（流式且没有 usage chunk）、`plugin` / `outcome`（被插件结束的请求）、`guardrail`（检测结果，只有实体类型）。`surface` 取值为 `chat`、`chat_stream`、`completions`、`completions_stream`、`embedding`、`image` 或 `passthrough`。

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

`/admin/*` 使用独立的认证（客户端认证会跳过它）：

```yaml
adminSecret: "一个足够长的随机密钥至少8个字符"   # 可选；生产环境至少 16 个字符
```

通过 `X-Admin-Secret` 头或 `Authorization: Bearer <密钥>` 发送。使用密钥库时（`ai-gateway serve`），`admin` / `read_only` 作用域的密钥同样可用，因此 `adminSecret` 是可选的；既没有密钥库也没有 `adminSecret` 时管理 API 被禁用（403）。详见[管理 API](#管理-api) 和[密钥作用域](#密钥作用域密钥库模式)。

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
requestTimeout: "30s"  # 默认 30s；也可 500ms、5m、1h、1m30s
```

设置 `AbortController`，超时后中止上游 fetch（504 `gateway_timeout`）。它覆盖到流式响应开始为止；之后流由 `server.streamIdleTimeoutSeconds` / `streamMaxDurationSeconds` 约束。

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

## 发布的模型（0.3.0）

网关只服务**已发布**的模型名。请求其他任何名字，都会在到达上游之前被拒绝：返回 `404 model_not_found`，并在提示里说明该模型未发布，可用 `GET /v1/models` 查看可用模型。

**默认（没有 `models:` 段）：** 各 target 的 `models` 列表里的模型都算已发布。请求只会发到列出了该模型的 target，顺序按全局 `strategy`（之后是其余列出它的 target），模型名不变。没有 `models` 列表的 target 不接任何请求（启动时会警告）。

**显式（`models:` 段）：** 由你决定对外模型名、由哪些渠道提供、上游用什么名字、以及在渠道间怎么选。此时全局 `strategy` 不再参与路由。

```yaml
strategy:
  mode: fallback
  targets: [deepseek-official, relay]
targets:
  - name: deepseek-official
    provider: deepseek
    apiKey: "${DEEPSEEK_API_KEY}"
  - name: relay
    provider: openai
    apiKey: "${RELAY_API_KEY}"
    baseURL: "https://relay.example.com/v1"
models:
  - name: my-chat                    # 客户端使用的名字
    displayName: "My Chat"
    strategy: fallback               # fallback（按优先级，默认）| loadbalance（按权重）
    bindings:
      - { target: deepseek-official, model: deepseek-chat }      # 发给上游时用 deepseek-chat
      - { target: relay, model: deepseek-chat-relay }            # 备用渠道，有自己的上游名
    metadata: { contextWindow: 65536, maxOutputTokens: 8192, tools: true, inputModalities: [text] }
  - name: gpt-4o
    bindings: [{ target: relay }]    # 上游名 = 对外名
  - name: preview
    enabled: false                   # 已发布但关闭：404「已禁用」
    bindings: [{ target: relay }]
aliases:
  chat: my-chat                      # 别名必须指向已发布的模型
```

**负载均衡（0.3.0）。** 一个模型的绑定按 `priority` 分成**优先级组**（数值小的优先；默认 = 列表顺序）。请求只发到最高优先级的组；只有该组所有渠道都不可用或都失败时才用下一组。组内顺序由 `balance` 决定：`weighted`（默认，按 `weight` 随机）、`round_robin`（轮询）、`least_inflight`（按权重折算后在途请求最少的优先）。`weight: 0` 表示摘除，`enabled: false` 表示关闭该绑定。`strategy: fallback`（默认）按优先级分组，所以不写 priority 就是传统的顺序降级；`strategy: loadbalance` 把所有绑定放进同一组。

```yaml
models:
  - name: ds-chat
    balance: round_robin
    bindings:
      - { target: ds-a, priority: 0 }
      - { target: ds-b, priority: 0, weight: 2 }
      - { target: relay, priority: 1 }        # 只有 ds-a 和 ds-b 都不可用时才用
```

**每个渠道多个 key。** `apiKeys`（配合 `keyStrategy`：`round_robin`、`weighted`、`fill_first`）把请求分摊到渠道的多个上游 key。上游返回 `429` 时该 key 暂停（按 Retry-After，上限 1 小时；没有则用 `keyCooldownSeconds`），同一请求立即换下一个 key 重试；`401` 会禁用该 key（状态 `invalid` 并记录错误，在配置库中持久化并写审计）然后换下一个 key。`402` 像 `429` 一样让该 key 冷却，但只是“软冷却”（渠道没有其他可用 key 时仍会用它，所以单个 `402`——例如 OpenRouter 针对请求的 “requires more credits, or fewer max_tokens”——不会让渠道下线），然后换下一个 key；只有同一个 key 在一小时内连续 3 次账户级 `402`、中间没有任何成功，才会被禁用（状态 `quota`）。`402` 不计入熔断，所有渠道都失败时原样以 `402` 返回给客户端。只有渠道的 key 全部用尽，才算该渠道失败并降级到下一个渠道；若全部 key 都在冷却，返回 `429` 和剩余的 `Retry-After`，若全部被禁用，返回 `503 no_upstream_key`。key 状态在内存中（每个请求零数据库读取），改配置不会清零。

如果一个模型的所有绑定都被关闭、摘除或指向已关闭的 target，它仍然保持发布：请求（包括它的别名）返回 `503 model_unavailable`，`/v1/models` 中以 `"available": false` 列出。每个模型对同一个 target 只能绑定一次。`metadata` 会显示在 `/v1/models` 中，并被强制执行（见下文）。使用配置库（`runtimeConfig.source: database`）时，模型和绑定与 target 一样入库、导入。

### 模型元数据会被强制执行（0.3.0）

请求离开网关前，会先对照已发布模型的 `metadata` 检查。模型做不到的请求**直接返回 `400` 并说明原因**，不会被压低或悄悄修改：

| 请求情况 | 依据的元数据 | `error.code`（`param`） |
|---|---|---|
| `max_tokens` / `max_completion_tokens` 超过上限 | `maxOutputTokens` | `max_tokens_exceeded` |
| 估算输入（中日韩字符每字 1 token，其他文本 UTF-8 字节 / 4）+ 输出上限超过上下文窗口 | `contextWindow` | `context_length_exceeded`（`messages`） |
| 模型不接受的图片 / 音频 / 视频 / 文件 | `inputModalities` | `unsupported_input_modality`（`messages`） |
| `tools` / `parallel_tool_calls: true` | `tools` / `parallelTools: false` | `tools_not_supported` / `parallel_tool_calls_not_supported` |
| 超出支持级别的 `response_format` | `structuredOutput`（`none` < `json_object` < `json_schema`） | `unsupported_response_format` |
| `logprobs` / `top_logprobs` | `logprobs: false` | `logprobs_not_supported` |
| `web_search_options` | `webSearch: false` | `web_search_not_supported` |
| `reasoning_effort` | `reasoning: false`，或不在 `reasoning.efforts` 中 | `reasoning_not_supported` / `unsupported_reasoning_effort` |

不改变含义的改写会自动进行：`developer` 消息按 `system` 发送（设 `developerRole: passthrough` 可保留原样）；`systemMessage: merge_into_user` 会把 system 内容并入第一条 user 消息；`reasoning.map` 把某个 `reasoning_effort` 值换成上游自己的参数。绑定上的 `params` 只给该渠道追加上游请求体字段：

```yaml
strategy: { mode: single, targets: [deepseek] }
targets:
  - { name: deepseek, provider: deepseek, apiKey: "${DEEPSEEK_API_KEY}" }
models:
  - name: chat
    bindings: [{ target: deepseek, model: deepseek-flash, params: { user_id: "gateway" } }]
    metadata:
      maxOutputTokens: 8192            # 对调用者的上限，必须在上游上限之内
      reasoning:
        efforts: [none, low, high, max]
        map:
          none: { thinking: { type: disabled } }
```

未填写的元数据取所有绑定上游都支持的部分（目前收录 DeepSeek 的 `deepseek-flash`、`deepseek-v4-pro`，数据来自 DeepSeek 自己的模型列表）：取最小的上限和共同支持的输入类型。已发布模型的承诺不能超过已知上游：`contextWindow` / `maxOutputTokens` 更大，或声明了上游没有的输入类型、结构化输出级别，都会配置报错。未知上游不做检查。旧版 `/v1/completions` 也做输出上限和上下文检查。

**每个 key 的模型白名单。** 密钥库里的 key 可以限定只能用部分已发布模型：`ai-gateway keys create --models my-chat,gpt-4o`，或在 `POST /admin/keys` / `PUT /admin/keys/:id` 中传 `"allowedModels": ["my-chat"]`（`null` = 全部模型，`[]` = 不能用任何模型；`PATCH` 时不传则保持不变）。别名本身或它指向的模型在白名单里即可使用。其他任何模型（无论是否发布）都返回 `403 model_not_allowed`（「This API key is not allowed to use the model …」），受限 key 无法借此探测白名单以外的模型。配置里的静态 `auth.keys` 不受限制。

**`GET /v1/models`** 只列出调用者的 key 可用的、已启用的模型和别名；`display_name`、`description`、`metadata`、`alias_of` 是扩展字段，OpenAI SDK 会忽略。

**透传代理：** 转发请求体里的 `model` 必须已发布且在 key 的白名单内；受限 key 必须带 `model`。没有 `X-Provider` 时发给该模型的第一个绑定；`X-Provider` 指定的渠道不提供该模型时返回 `400 provider_not_bound`。请求体原样转发，所以绑定里的上游改名在透传代理上不生效。

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
| `registerProvider(provider)`         | 运行时添加 provider（重载后保留）             |
| `registerPlugin(stage, plugin)`      | 运行时添加插件（重载后保留）                  |
| `reload(config)`                     | 不重启换上新配置（见下文）                    |
| `currentSnapshot()`                  | 当前运行时代：`version`、`config`、`createdAt` |
| `onReload(listener)`                 | 每次重载成功后调用；返回取消订阅函数            |
| `getConfig()`                        | 获取当前配置（只读）                         |
| `initMcp()`                          | 连接配置的 MCP 服务器                      |
| `addRequestLogSink(sink)`            | 接收每条 finalize 后的请求日志                |
| `close()`                            | 优雅关闭                               |

### 实时重载（嵌入模式）

`gateway.reload(config)` 用 `config` 组装一套完整的新运行时（provider、策略、插件、熔断器、并发限制器、pipeline），再用一次引用赋值换上。传入的配置与构造函数的形式相同（已校验：`loadConfigFromPath` / schema）。0.3.0 的 Admin API 和控制台建立在它之上；HTTP 服务目前还没有暴露它。

- 已在运行的请求（包括流）在开始时的运行时上跑完；新请求用新运行时。
- 配置无效时抛错，当前运行时继续服务（`currentSnapshot().version` 不变）。
- 配置未变的熔断器、并发限制器、插件保留状态（熔断状态、占用中的并发槽位、限流窗口）；配置变了的重新开始。并发上限改变时换新限制器，已持有旧槽位的请求短时间内不计入新上限。
- `mcpServers` 不能在运行时修改（抛 `ReloadRejectedError`）。server、auth、CORS 等进程级设置由 HTTP 层在启动时读取，不受重载影响。

---

## 架构

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
│  dashboard/     /admin/dashboard console (embedded Preact app, console/)       │
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
│  token, pii-secret- │  │  concurrency-limiter queue,│  │  presets.ts),        │
│  guard              │  │  retry (exp. jitter)       │  │  wire-extras,        │
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

### 请求流程

非流式 `POST /v1/chat/completions`（其他 surface 走同一条 pipeline；embeddings 和 images 不跑 MCP 循环）：

```
客户端
  │
  ├─ 中间件：recover、body-limit、安全头、CORS、指标、排空闸门、
  │   客户端认证（/v1/* 接受 inference / read_only / admin 任一作用域）、
  │   按 IP 限流（配置后才开启）、请求超时
  │
  ├─ handlers/chat.ts：解析 JSON、Zod 校验、wire → 内部请求
  │
  ├─ gateway.execute(chatSurface)  →  core/pipeline.ts
  │   │
  │   ├─ 1 别名解析（aliases）
  │   ├─ 1b 模型访问（已发布模型、key 的 allowed_models）、key 限额
  │   │     （usage/key-meter.ts：额度 403、RPM / TPM 429；只用内存）
  │   ├─ 2 before 插件，按配置顺序：rate-limit、word-filter、max-token、
  │   │     pii-secret-guard、cache 查询 ……
  │   │     拒绝 → finalize → 错误；短路（缓存命中）→ finalize → 200
  │   ├─ 3 插件视图写回；注入 MCP 工具（chat，非流式）
  │   ├─ 4 strategy.selectTargets() → 有序候选目标
  │   ├─ 5 core/executor.ts，逐个候选：
  │   │     breaker.acquire()（打开 → 跳过；全部打开 → 503 circuit_open）
  │   │     → limiter.acquire(signal)（队列满 / 截止时间到 → 429 gateway_overloaded）
  │   │     → 调用 provider，外面包一层该目标的 retry
  │   │     → 结果分类（core/outcome.ts）→ 结算熔断器 permit
  │   │     → 可 failover（网络、5xx、408、429、401/403/404）？下一个候选
  │   │       调用方 4xx / 客户端中止 / 网关超时？结束
  │   ├─ 6 MCP 循环：网关侧工具的 tool_calls → 调用工具 → 再走第 5 步
  │   │     （直到没有 tool_calls 或达到 maxCallDepth；usage 累加）
  │   └─ 7 finalize，恰好一次：after / on_error 插件（缓存写入、响应扫描）
  │         → settle 回调 → key 计量（token 计入额度 / TPM）→ 请求日志
  │         （stdout + SQLite、用量汇总，批量写入）
  │         → 指标 → 结束 span
  │
  └─ handlers：内部响应 → OpenAI wire JSON（+ X-Gateway-* 响应头）
```

流式请求（`stream: true`，chat 与 completions）走 `gateway.executeStream()` →
`core/chat-stream.ts` 和 `core/stream-runner.ts`：before 插件和候选目标与上面相同；
首个 chunk 之前的失败按第 5 步 failover，之后目标固定。流的结束类型为 `done`、
`truncated`、`upstream_error`、`idle_timeout` 或 `client_cancel`；无论哪种结束，
finalize 都只运行一次。网关总是向上游要 usage 分块（`stream_options.include_usage`），
客户端自己没要时只计量、不把 usage 转给它；只有上游确实没给 usage 时才估算（区分中日韩字符）。只有正常完成的流才写
`data: [DONE]`，其他结束方式发送不带 `[DONE]` 的 SSE 错误事件。流式请求不注入 MCP 工具。

透传（`passthroughProxy.enabled`）：白名单检查 → before 插件（`core/surfaces/passthrough.ts`）
→ `proxy/proxy.ts` 原样转发；没有熔断、failover、after 插件和 token 计量。

### 项目结构

```
src/
├── index.ts                 # 包入口（嵌入模式导出）；直接执行时运行 CLI
├── gateway.ts               # Gateway 门面：execute / executeStream、route、embed、MCP
├── app.ts                   # Hono 应用：中间件顺序、handler、代理、admin、/metrics
├── version.ts               # VERSION
│
├── cli/
│   ├── index.ts             # serve | validate | keys | config | version（原生 argv 解析）
│   ├── keys.ts              # 直接操作 SQLite 密钥库的 keys create | list | revoke
│   └── config.ts            # 运行时配置库的 config import | status
├── server/
│   ├── bootstrap.ts         # 唯一的服务启动路径：存储、安全检查、OTel、监听器
│   ├── shutdown.ts          # SIGTERM/SIGINT 排空、在途计数、宽限期后强制关闭
│   └── route-path.ts        # 路径规范化（//、结尾 /、%2F、大小写）
│
├── config/
│   ├── schema.ts            # 严格 Zod schema（未知键报错并给出提示）
│   ├── loader.ts            # YAML/JSON 文件 + AI_GATEWAY_* 覆盖，validateConfig()
│   ├── runtime-source.ts    # 启动：文件或配置库、首启导入、合并并重新校验
│   ├── stable-key.ts        # 确定性 JSON 标识键
│   ├── validate.ts          # 交叉引用检查 + 内置插件 config 校验
│   ├── removed.ts           # 已移除 / 不支持的键与模式及迁移提示
│   ├── strict.ts            # 严格对象（未知键给出“是否想写”/迁移提示）
│   ├── duration.ts          # 唯一的时长解析器（ms|s|m|h，可组合如 1m30s）
│   ├── production-safety.ts # GATEWAY_ENV=production 启动检查
│   ├── envref.ts            # ${VAR} 展开
│   └── types.ts
│
├── middleware/
│   ├── recover.ts  body-limit.ts  security-headers.ts  cors.ts
│   ├── auth.ts              # 客户端认证 + 管理认证（常量时间比较、作用域）
│   ├── per-ip-rate-limit.ts # 按客户端 IP 的令牌桶（默认关闭）
│   ├── trusted-proxy.ts     # TRUSTED_PROXIES / X-Forwarded-For 解析
│   └── request-timeout.ts   # AbortController 截止时间（默认 30s）
│
├── handlers/
│   ├── chat.ts  completions.ts  embeddings.ts  images.ts   # POST /v1/*
│   ├── models.ts  capabilities.ts  health.ts               # GET /v1/models, /v1/capabilities, /health /livez /readyz
│   ├── request.ts           # RequestContext、中止信号联动
│   ├── openai-wire.ts       # snake_case wire ⇄ camelCase 内部类型
│   ├── error-response.ts    # OpenAI 形状的错误响应
│   ├── sse-stream.ts  sse-heartbeat.ts  abort.ts
│
├── core/
│   ├── pipeline.ts          # execute(surface, req, ctx)：第 1–7 步，finalize 一次
│   ├── chat-stream.ts       # chat / completions 的 executeStream
│   ├── stream-runner.ts     # 首个 chunk + failover、流结束类型、SSE 写出
│   ├── executor.ts          # 候选执行器：熔断 → 限并发 → 调用 → 重试 → failover
│   ├── outcome.ts           # 单次尝试分类（熔断结算、是否 failover）
│   ├── errors.ts            # GatewayError、OpenAI 错误形状、mostMeaningful()
│   ├── mcp-loop.ts          # MCP 智能体循环（usage 累加）
│   ├── mcp-runtime.ts       # MCP 连接 / 就绪状态
│   ├── assembly.ts          # 配置 → registry、插件、策略、熔断器、限流器、pipeline
│   ├── strategy-config.ts   # config.strategy → 模式 + 各模式配置
│   ├── provider-presets.ts  # 22 个 provider 预设（base URL、别名、附加项）
│   ├── usage.ts             # usage 累加、流式估算
│   ├── types.ts             # Surface, RequestRun, FinalizeOutcome, StreamEnd
│   └── surfaces/            # chat, completions, embeddings, images, passthrough
│
├── routing/
│   ├── types.ts             # IStrategy { mode, selectTargets }
│   ├── strategy-factory.ts
│   ├── single.ts  fallback.ts  loadbalance.ts  conditional.ts
│   ├── model-catalog.ts     # 已发布模型：绑定、按模型路由、key 白名单
│   ├── balancer.ts          # 优先级组；组内 weighted / round_robin / least_inflight
│   ├── key-pool.ts          # 每个渠道多个上游 key：选择、429/402 冷却、401 禁用
│   ├── circuit-breaker.ts   # 基于 permit 的状态机 + 注册表
│   ├── concurrency-limiter.ts # 每目标槽位、可中止的等待队列
│   ├── retry.ts             # 带抖动的指数退避
│   └── outcome.ts           # 转导出 core/outcome.ts
│
├── providers/
│   ├── openai-compat.ts     # 唯一的 OpenAI 兼容适配器
│   ├── wire-extras.ts       # 白名单透传字段
│   ├── sse-parser.ts        # 上游 SSE 解析器（单事件上限 4 MiB）
│   ├── capabilities.ts      # 各 provider 参数矩阵（兼容性模式）
│   ├── response-headers.ts  # 转发的上游响应头
│   └── registry.ts  types.ts  index.ts
│
├── plugins/
│   ├── manager.ts  context.ts  error.ts  types.ts
│   └── builtins/            # 5 个内置插件 + from-config.ts + config-schemas.ts（插件 config 严格校验）
│       ├── rate-limit.ts  cache.ts  word-filter.ts  max-token.ts
│       └── pii-secret-guard/   # config, detectors, validators, plugin
│
├── mcp/                     # stdio 客户端（MCP 2025-03-26 子集）、registry、executor
├── proxy/proxy.ts           # 白名单 /v1/* 路由的透传代理
├── usage/
│   ├── key-meter.ts         # 每个 key 的 token 额度、RPM、TPM（内存计数，重载不清零）
│   ├── usage-store.ts       # 按小时的用量汇总（usage.sqlite）
│   └── recorder.ts          # 汇总与已用 token 的异步批量写入
├── secrets/secret-box.ts    # 上游 key 的 AES-256-GCM + HKDF 加密封装（GATEWAY_SECRET_KEY）
├── security/url-guard.ts    # SSRF 防护：base URL 只允许公网、DNS 检查、受限 fetch
├── persistence/
│   ├── key-store.ts         # API 密钥（SHA-256）、作用域、WAL、bootstrap 闩锁
│   ├── config-store.ts      # 运行时配置库：渠道、加密 key、模型、版本、审计
│   ├── request-log-store.ts # /admin/logs 存储
│   └── migrations.ts        # 带版本的 SQLite 迁移
├── auth/                    # bootstrap.ts（bootstrap 密钥闸门）、key-hash.ts
├── admin/                   # /admin/* API：运行时配置（config-api.ts、config-schemas.ts、guards.ts：
│                            #   CSRF / If-Match / 限流）、密钥（含限额、reset-usage）、用量、日志、状态
├── dashboard/               # 提供控制台；assets.generated.ts 为构建后的 console/（内嵌）
├── observability/           # OTel SDK + tracer 桥接、采样/隐私、请求日志、脱敏
├── metrics/metrics.ts       # Prometheus 注册表（prom-client）
└── types/assets.d.ts

tests/
├── unit/                    # 各模块单元测试
├── integration/             # 进程内完整请求流程
├── regressions/             # 导入的 bug 复现，现为回归测试
├── types/                   # 测试用类型声明
├── e2e/                     # 真实服务器 + mock 上游 + openai SDK（bun run test:e2e）
└── browser/                 # Playwright：在 Chromium 里对真实服务器操作管理控制台（bun run test:browser）
scripts/                     # smoke-real-deepseek.ts, docker-smoke.sh, binary-smoke.sh, build-binaries.sh, release-notes.sh
```

---

## 开发

### 脚本

```bash
bun run dev              # 启动（文件监视，bun run --watch src/index.ts）
bun run start            # 启动（无监视）
bun run test             # 单元 + 集成 + 回归测试（bun test）
bun run test:e2e         # E2E 契约测试：真实服务器、mock 上游、openai SDK
bun run test:browser     # 浏览器 e2e：Playwright 在 Chromium 里操作管理控制台
bun run smoke:real       # 可选：对真实 DeepSeek API 的冒烟测试（需要 DEEPSEEK_API_KEY）
bun run test:watch       # 监视模式运行测试
bun run typecheck        # tsc 类型检查（src）
bun run typecheck:tests  # tsc 类型检查（tests）
bun run lint             # biome ci .
bun run lint:fix         # biome lint --write .
```

### 运行测试

```bash
# 所有测试（单元 + 集成 + 回归）
bun test

# E2E 测试（CI 两者都跑）
bun run test:e2e

# 指定测试文件
bun test tests/unit/routing/fallback.test.ts

# 监视模式
bun run test:watch

# 浏览器 e2e（Playwright + Chromium，仅开发依赖）
bunx playwright install --with-deps chromium   # 首次
bun run test:browser
# arm64 Linux 没有 Playwright 的 Chromium 下载，改用系统 Chromium
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium bun run test:browser

# 真实 DeepSeek 冒烟（可选，约 6 次真实请求；没有 key 时跳过）
DEEPSEEK_API_KEY=sk-... bun run smoke:real
```

**浏览器 e2e**（`tests/browser/*.browser.ts`，`playwright.config.ts`）。每个测试文件启动自己的网关
（`tests/browser/support/server.ts`：真实的 `bootstrap()`，临时数据目录和 `GATEWAY_SECRET_KEY`），以及进程内的假
OpenAI 兼容上游（主机名在 `.upstream.test` 下）。渠道通过控制台创建，生产环境的 SSRF 防护不变：测试只通过仅供嵌入方使用的
`hostResolver` 覆盖项把这些假主机名解析成公网地址，并在进程内应答。覆盖：登录（错误 key、权限不足、锁定、退出、会话失效 →
回到登录页）、中英切换并保持、所有页面无控制台错误且**无 CSP 违规**（监听 `securitypolicyviolation`，有就失败）、渠道向导
（选预设 → 填 key → 测试 → 拉模型 → 发布）后模型可在 `/v1` 调用、模型抽屉（元数据、用箭头和拖拽调整绑定顺序 →
“已生效 · 版本 #N”，新顺序立即生效）、创建密钥（明文只显示一次）→ 调 `/v1` → 显示用量 → 额度用完（`403 quota_exhausted`）
→ 调高 / 清零 / 吊销、两个页面同时编辑的 `409`“已被修改，请刷新”、服务端校验错误显示在字段上、用量图表、日志、Playground
流式与停止、流进行中改配置（流照常结束）、版本对比与回滚（立即生效）、审计、会话列表与吊销（另一个浏览器被登出）、CSRF
（Cookie 写请求不带 token → `403`）。CI 单独一个 job 运行，失败时上传 trace 和截图；release 复用 CI，所以发版需要它通过。

**真实 DeepSeek 冒烟**（`scripts/smoke-real-deepseek.ts`，不在 CI 中运行）：通过 Admin API 创建 DeepSeek 渠道（公网 SSRF
策略），测试连通、拉模型列表、发布一个模型（`SMOKE_MODEL`，默认 `deepseek-v4-flash`，没有则取列表中第一个 `flash`
模型），检查未发布 → `404`、超限 `max_tokens` → `400`，用带额度的 key 做非流式和流式调用，检查用量计入、已放行的流结束时超出额度、
下一次请求得到 `403 quota_exhausted`，并读取 `GET /admin/channels/:id/balance`。

---

## 从 Go ai-gateway 迁移

| Go 功能                               | TypeScript 对应                     |
| ----------------------------------- | --------------------------------- |
| `ferrogw serve`                     | `ai-gateway serve -c config.yaml` |
| 29 个提供商（含 Anthropic/Gemini/Bedrock） | 20+ 个 OpenAI 兼容提供商                |
| 非 OpenAI 线路协议翻译                     | 不支持（设计决策）                         |
| Dashboard UI                        | 管理控制台（`/admin/dashboard`，Preact，中英双语） |
| `NonOpenAIWireProvider` 代理拒绝        | 带 `baseURL` 的通用回退                 |
| `sync.Pool` 上下文池                    | 标准 JS 模式                          |
| `httputil.ReverseProxy` 透传代理        | 需显式开启的白名单代理（`passthroughProxy`） |
| 每目标并发限制                             | `targets[].concurrency`（`maxConcurrency`、`queueSize`） |
| 8 种路由策略                             | 4 种（`single`、`fallback`、`loadbalance`、`conditional`），见[已移除的策略](#已移除的策略020) |
| MCP stdio + HTTP                    | 仅 stdio                            |
| 模型目录 / 动态发现                         | 仅静态配置                             |
| 配置文件监视                              | 不支持：改文件后重启                   |

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。

本项目的设计源自 [Ferro Labs AI Gateway](https://github.com/ferro-labs/ai-gateway)（Apache-2.0），署名保留在 [NOTICE](NOTICE)。
