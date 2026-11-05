# 从 0.2.x 升级到 0.3.0

English: [migration-0.3.md](migration-0.3.md)（更完整，含每条破坏性变更与对应操作的对照表）

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

## 回退到 0.2.x

0.2.x 不读 `config.sqlite`，重新以配置文件为准：保留导入前的配置文件，恢复第 1 步的数据目录备份，并从文件中删掉
0.3.0 才有的键（`models:`、`limits:`、`console:`、`runtimeConfig:`、`apiKeys`）。
