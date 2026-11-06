# 从 0.2.x 升级到 0.3.0

English: [migration-0.3.md](migration-0.3.md)（更完整，含每条破坏性变更与对应操作的对照表）

**已经在用 0.3.0？** 见文末 [从 0.3.0 升级到 0.3.1](#从-030-升级到-031)。

0.3.0 起，渠道、上游 key、发布模型和路由保存在 SQLite 配置库里，可在控制台 / Admin API 中在线修改、无需重启；
分发给别人的 key 有 token 额度和 RPM / TPM。完整变更见 [CHANGELOG.md](../CHANGELOG.md#030---2026-11-05)。

## 升级清单

1. **先备份**数据目录（`GATEWAY_DATA_DIR`，默认 `./.data`）和配置文件。
2. **设置 `GATEWAY_SECRET_KEY`**：只要 `targets[].apiKey` 里有明文 key（不是 `"${VAR}"` 引用），或使用
   `GATEWAY_ENV=production`，就必须设置（`openssl rand -base64 32`）。丢了它，库里加密的上游 key 就无法解密。
3. **同机反向代理（nginx / Caddy）后面必须设 `TRUSTED_PROXIES=127.0.0.1,::1`**；负载均衡后面填它的网段。默认
   不再信任任何代理（0.2.x 默认信任回环），不设置时所有客户端共用代理的 IP，一个人输错密码会把所有人锁在外面。
4. **只服务已发布的模型**：未发布的模型名直接 `404 model_not_found`，不再走全局策略兜底。没有 `models:` 段时，
   每个 target 必须在 `targets[].models` 里列出它服务的模型；没有 `models` 的 target 什么都不服务。
5. **删除** `budget` 插件和 `costPer1k*` 价格字段（0.3.0 没有任何价格/费用，留着会校验失败），改用 key 的
   `quotaTokens`。
6. 用 0.3.0 运行 `ai-gateway validate -c config.yaml`，按提示删掉已移除的键。
7. 启动后在 `/admin/dashboard` 用 admin key 或 `adminSecret` 登录，`ai-gateway config status` 检查导入结果。

## 主要变化与对应操作

- **配置库与首启导入**：首次启动把配置文件的运行时段（targets、strategy、aliases、plugins、compatibility、
  models、limits）导入 `config.sqlite`，之后**再改文件里这些段会被忽略**（启动时警告）。在控制台 / API 修改，或
  `ai-gateway config import --force` 后重启。GitOps 部署用 `runtimeConfig: { source: file }` 保持 0.2.x 行为
  （只读，写操作 `403 config_read_only`）。
- **响应里的 `model` 是发布名**：所有响应（含每个流式 chunk）、请求日志和 token 指标的 `model` 都是发布名，
  上游真实模型名在新的 `upstreamModel` 字段。按上游名匹配的客户端/看板需要改。透传路由保持原样。
- **额度与预留**：key 有 `quotaTokens` / `rpm` / `tpm`。用完 → `403 quota_exhausted`（不会自动恢复）。有额度或
  TPM 的 key，每个进行中的请求预留“估算 prompt + 输出上限”；输出上限 = `max_tokens` / `max_completion_tokens`
  中较大者，否则模型的 `maxOutputTokens`，否则 `limits.maxOutputTokens`（**默认 65536**）。已用 + 预留 ≥ 额度时
  返回 **`429 quota_in_flight`**（`Retry-After: 1`）。剩余额度小于约 6.5 万 token 的 key，在模型没设
  `maxOutputTokens`、请求也不带 `max_tokens` 时会很快遇到 429：给模型设合理的 `maxOutputTokens`、调低
  `limits.maxOutputTokens`，或让客户端带上 `max_tokens`。有额度的 key 调用图片生成和透传路由 →
  `403 quota_not_metered`。
- **0.3.0 之后的版本**（最终红队 2026-11-06 FQ-1 / FQ-2）：图片、音频、文件计入预留（每张图约 1,600 token），
  推理预算（`reasoning.max_tokens`、`thinking.budget_tokens` 等）也计入；单个请求超过剩余额度 →
  **`400 request_exceeds_quota`**，超过 TPM → **`400 request_exceeds_tpm`**；`n` > 128 → `400 invalid_n`；只有
  已用 + 已预留 + 本请求预留 ≤ 额度时才放行。不带 `max_tokens` 的请求，默认上限会收进剩余额度 / TPM，并作为
  `max_tokens` 显式发给上游（模型声明了 `maxOutputTokens` 时，不限额的 key 也一样）。**要做的**：额度快用完时让
  客户端带较小的 `max_tokens`；上游拒绝显式 `max_tokens` 时，把模型的 `maxOutputTokens` 设成上游的真实上限。
- **0.3.0 之后的版本**（FQ-3）：上游因请求*内容*返回 `403` / `451`（OpenRouter “input was flagged”、OpenAI 安全
  系统、DeepSeek “Content Exists Risk” 等）→ `400 content_filtered`，不切换渠道、不计入熔断（原来是
  `502 upstream_auth_failed`，三个被拦的提示词就能让整个渠道熔断）。凭证 / 账户 / 地区类 403 不变。
- **`max_tokens` 规则**：`max_tokens` 与 `max_completion_tokens` 值不同 → `400 conflicting_max_tokens`；超过模型
  `maxOutputTokens`（否则 `limits.maxOutputTokens`）→ `400 max_tokens_exceeded`，一律拒绝、不压低。
- **透传代理**：仍默认关闭；新增限制：重复的顶层 JSON 键 → `400 duplicate_json_key`，输出上限同样受模型限制，
  `X-Provider` 只能选该模型绑定的渠道（`400 provider_not_bound`）。
- **超时不再计入熔断**：网关 `requestTimeout` 默认不算熔断失败；需要旧行为时给渠道设
  `circuitBreaker.countTimeouts: true`（配置文件或 Admin API，控制台暂无开关）。
- **模型名规则**：Admin API 写入的模型名须为 1–256 个 `A–Z a–z 0–9 . _ : / @ -`（`400 invalid_model_name`）；启用的
  模型至少要有一个绑定（`400 model_no_bindings`，草稿可先 `enabled: false`）。
- **管理端认证**：`X-Admin-Secret` / Bearer 连续失败 5 次（15 分钟内）锁定该 IP，此后连正确的凭据也返回
  `429 auth_locked`。脚本不要用错误密钥反复重试。控制台改为会话 Cookie 登录，0.2 的旧控制台和 `/admin/static/*`
  已删除。
- **渠道换地址要重新给 key**：`PATCH` 把渠道改到另一个源（协议、主机或端口，含改 `preset` 或 `baseURL: null`）时
  必须同时带 `apiKeys`，否则 `400 api_keys_required_on_base_url_change`。API 写入的 base URL 只允许公网地址；
  本地/局域网服务（Ollama、vLLM）暂时只能写在配置文件里。
- **列表格式**：0.2 的接口保持原样（`/admin/keys` → `{ keys, total }`，`/admin/logs` → `{ entries, total }`），
  0.3.0 新资源列表为 `{ object: "list", data }`，见 [admin-api.md](admin-api.md#list-responses)。

## 从 0.3.0 升级到 0.3.1

同样适用于 0.3.2（0.3.1 的重新发布，只修了发布流程；0.3.1 没有 GitHub Release）。

0.3.1 可直接替换升级：数据目录、配置文件不变，没有迁移步骤，也没有新的必填设置。替换二进制 / 镜像并重启后，
留意以下行为变化（详见 [CHANGELOG.md](../CHANGELOG.md#031---2026-11-06)）：

1. **跨站请求 Admin API 一律 `403 csrf_rejected`，包括 `GET`**（0.3.0 只拒绝写操作），`/admin/*` 也不再返回任何
   CORS 头。带 `Sec-Fetch-Site: cross-site`、或 `Origin` 既不是网关自身也不在 `cors.origins` 中精确列出（`*` 不算）
   的请求，在检查凭据之前就被拒绝。curl、脚本、CLI（不带 `Origin`）以及同源打开的控制台不受影响；控制台页面本身
   （`/admin/dashboard`、静态资源、favicon）从其他网站点链接仍可打开，只检查它背后的 API 调用（均为同源）。
   其他源上的浏览器应用若要调用 Admin API，需改为从网关同源提供。
2. **用 `ai-gateway keys` CLI 吊销或新建的 key，约 1 秒内在运行中的服务上生效**（`KEY_STORE_SYNC_INTERVAL_MS`，
   默认 `1000`），不再是“下一个请求立即生效”。通过 Admin API / 控制台吊销、轮换、修改仍立即生效——需要立刻生效时用它们。
3. **客户端没传 `max_tokens` 时，网关会显式向上游发送 `max_tokens`**：有 token 额度或 TPM 的 key，发送按剩余额度 /
   TPM 收窄后的默认输出上限；模型声明了 `maxOutputTokens` 时（任何 key），发送该值（不超过上下文窗口减去提示词）。
   对 api.openai.com 使用 `max_completion_tokens`。**请把每个模型的 `maxOutputTokens` 设为上游真实的输出上限**，
   否则上游若拒绝过大的 `max_tokens`，0.3.0 能成功的请求会失败。
4. **新配置项**（启动设置，均可选，括号内为默认值，只有想改默认值时才需要写）：
   `console.maxSessionsPerCredential`（5，每个 key / `adminSecret` 的控制台会话数，新登录结束该凭据最旧的会话）、
   `console.maxLoginsPerMinute`（20，每个客户端 IP 每分钟成功登录次数，超出 `429 login_rate_limited`）、
   `audit.maxRows`（50000，审计日志保留行数）、`audit.retentionDays`（90，审计日志保留天数）、
   `maxUpstreamResponseBytes`（32 MiB，非流式上游响应解压后上限，超出 `502 upstream_response_too_large`）、
   `maxUpstreamErrorBodyBytes`（64 KiB，上游错误体读取上限）。
   新环境变量：`KEY_STORE_SYNC_INTERVAL_MS`（默认 1000，50–10000）、`REQUEST_LOG_FLUSH_INTERVAL_MS`（默认 1000）；
   新指标 `ai_gateway_request_log_dropped_total`。
5. **透传路由的上游错误体上限为 64 KiB**（`maxUpstreamErrorBodyBytes`，原先固定 1 MiB），适用于 `/v1/responses`、
   `/v1/moderations`、`/v1/audio/*`；更大的错误体返回上游状态码加通用提示。透传成功响应不再带上游的
   `Content-Encoding`、`Set-Cookie` 和 CORS 头。
6. **新错误码**——客户端和脚本需要处理：
   - `400 request_exceeds_quota`：单个请求的预留超过 key 剩余额度，请调小 `max_tokens` / `n`
   - `400 request_exceeds_tpm`：单个请求的预留超过 key 的 TPM，请调小 `max_tokens` / `n`
   - `400 invalid_n`：`n` 超过 128
   - `400 content_filtered`：上游因内容审核拒绝（取代此类情况下的 `502 upstream_auth_failed`）
   - `502 upstream_response_too_large`：上游响应超过 `maxUpstreamResponseBytes`
   - `503 session_limit`：控制台登录时会话表已被其他凭据占满（`Retry-After: 60`）
   - `429 login_rate_limited`：同一 IP 成功登录过于频繁

   另外：额度准入改为精确判断（已用 + 预留 + 本请求 ≤ 额度），图片 / 音频 / 文件和推理预算也计入预留，
   有额度的 key 上能同时运行的多模态 / 推理请求会变少（更早出现 `429 quota_in_flight`）。

回退到 0.3.0 只需换回旧二进制：0.3.1 没有数据库结构变化；但 0.3.0 的严格校验不认识上面的新配置项，回退前请先删掉它们。

## 回退到 0.2.x

0.2.x 不读 `config.sqlite`，重新以配置文件为准：保留导入前的配置文件，恢复第 1 步的数据目录备份，并从文件中删掉
0.3.0 才有的键（`models:`、`limits:`、`console:`、`runtimeConfig:`、`apiKeys`）。
