# AI Gateway — 任务计划

> **此文件是所有后续 AI 工作的唯一权威参考。每次开始工作前必读此文件，严格按计划执行，不得偏离。**
>
> 当前状态：**v0.2.0 已发布**（tag `v0.2.0`）。第 5 节的初始阶段与 0.2.0 重构均已完成；
> 后续工作从第 6 节（待办）开始。行为细节以 README.md / README_CN.md 和 CHANGELOG.md 为准，二者与代码不一致时以代码为准并修文档。

## 1. 项目定义

| 项 | 值 |
|---|---|
| **目标** | 用 TypeScript 重写 Go 版 ai-gateway（设计源自 [Ferro Labs AI Gateway](https://github.com/ferro-labs/ai-gateway)，见 NOTICE），只兼容 OpenAI 兼容协议 |
| **原项目** | Go 版 ferro-labs/ai-gateway（仅作参考，不在本仓库内） |
| **本仓库** | `brokenstring314/ai-gateway`，仓库根目录即项目根目录（package 名 `ai-gateway-rewrite`） |
| **运行时** | Bun ≥ 1.4.3（`.bun-version`；1.3.x 的 fake timer 会让测试失败） |
| **框架** | Hono |
| **验证** | Zod（schema 即验证即类型；配置 schema 严格，未知键报错） |
| **测试** | `bun test`（单元 + 集成 + 回归）与 `bun run test:e2e`（真实服务器 + mock 上游 + openai SDK） |
| **语言** | TypeScript strict mode（`strict: true`, `noUncheckedIndexedAccess`, `noImplicitOverride`） |
| **CI** | `.github/workflows/ci.yml`：biome ci、typecheck（src + tests）、bun test、test:e2e、Docker 构建 + 冒烟；`release.yml`：打 tag 发布 GHCR 多架构镜像与 5 个平台的编译二进制 |

## 2. 核心约束（不可违反）

1. **只兼容 OpenAI 兼容协议** — 不做 Anthropic/Gemini/Bedrock/Cohere/Vertex AI 翻译层
2. **无安全漏洞** — 输入验证用 Zod，API key 不入日志，请求体大小限制，CORS 可配置，安全头默认开启，客户端认证默认开启
3. **高度可测试** — 每个模块必须有单元测试，核心流程有集成测试和 e2e 契约测试，mock 友好的接口设计
4. **范围以 0.2.0 为准** — 0.2.0 有意收窄了原项目的范围（见 3.11），不要把已移除的功能加回来，除非计划明确要求
5. **完全可用** — 必须能 `bun run` 启动，用 curl/OpenAI SDK 实际调用成功
6. **性能不差太多** — LLM gateway 瓶颈在 upstream，网关自身延迟 <5ms 即可
7. **不卡住** — 遇到解决不了的问题立即降级/简化，记录在案，继续推进，绝不循环
8. **文档同步** — 改行为必须同时改 README.md、README_CN.md（两者保持一致）和 CHANGELOG.md

## 3. 功能清单（v0.2.0 状态）

### 3.1 Provider 系统
- [x] `IProvider`（`name`, `complete()`, `supportedModels()`, `supportsModel()`, `models()`）、`IStreamProvider`、`IEmbeddingProvider`、`IImageProvider`
- [x] Provider Registry：注册、查找、按模型查找
- [x] 通用 OpenAI-compatible 适配器（`providers/openai-compat.ts`，一个实现覆盖全部 provider）
- [x] 22 个 provider 预设，集中在一张表 `core/provider-presets.ts`：openai, deepseek, groq, mistral, xai, qwen, moonshot, together, fireworks, deepinfra, ai21, cerebras, sambanova, novita, nvidia_nim, ollama, openrouter, perplexity, replicate, huggingface, cloudflare, databricks（后两者必须配置 `baseURL`）
- [x] 每个 provider 的 capabilities 声明；兼容性模式 warn / drop / reject（按 `target.provider` 查找）
- [x] 白名单 wire 字段透传（`providers/wire-extras.ts`）
- [—] ~~`IDiscoveryProvider` 动态模型发现~~：0.2.0 删除（从未有实现），模型列表只来自静态配置

### 3.2 路由策略（4 种）
- [x] Single、Fallback、LoadBalance（权重 0 = 摘除）、Conditional（`model` / `user` / `message` / `prompt` + `pattern` 或 `contains`）
- [x] 策略只负责排序候选目标（`IStrategy.selectTargets`），统一由 `core/executor.ts` 执行：熔断器 permit → 并发限制队列 → 调用 → 重试 → 按 `core/outcome.ts` 分类决定是否 failover
- [x] 每目标重试（指数抖动退避）、熔断器（基于 permit 结算）、并发限制（`targets[].concurrency`）
- [—] ~~LeastLatency、CostOptimized、ContentBased~~：0.2.0 移除（配置会报错并给出迁移提示）；`abtest` 作为 `loadbalance` 的废弃别名保留到 0.3.0

### 3.3 插件系统
- [x] 生命周期：`before_request` / `after_request` / `on_error`；插件管理器：注册、执行链、短路、拒绝（可带 status / Retry-After / code）
- [x] 内置插件（6 个）：rate-limit、cache、word-filter、max-token、budget（before 预留、after 结算）、pii-secret-guard（PII + 密钥检测：block / redact / log）
- [—] ~~Logger 插件~~：0.2.0 移除（与网关自带请求日志重复；配置中出现会被忽略并告警）

### 3.4 MCP (Model Context Protocol)
- [x] MCP Server 配置（仅 stdio；崩溃后指数退避重连；环境变量白名单隔离）
- [x] 工具发现、工具注入（仅非流式请求）、Agentic loop（`core/mcp-loop.ts`，每轮走 executor，usage 累加，超深度 502）
- [—] ~~HTTP 传输~~：0.2.0 从 schema 移除（从未实现）

### 3.5 API 端点
- [x] `POST /v1/chat/completions`（非流式 + 流式 SSE）、`POST /v1/completions`（legacy wire 格式）、`POST /v1/embeddings`、`POST /v1/images/generations`
- [x] `GET /v1/models`、`GET /v1/capabilities`、`GET /health`、`GET /livez`、`GET /readyz`、`GET /metrics`
- [x] 可选的白名单透传代理（`passthroughProxy`，默认 `POST /v1/responses`、`/v1/moderations`、`/v1/audio/*`）
- [x] Admin API：只读配置、API key 管理（作用域 inference / read_only / admin，revoke / rotate）、日志查看与清理、状态概览
- [x] 管理控制台 `/admin/dashboard`（概览、密钥、日志、只读配置）

### 3.6 中间件
- [x] recover、请求体大小限制（默认 10MB）、安全头、CORS（可配置）、客户端认证（Bearer，常量时间比较）、按 IP 限流（默认关闭）、请求超时（默认 30s）、关闭时排空

### 3.7 可观测性
- [x] OpenTelemetry tracing（每请求一个根 span，OTLP/HTTP 导出，采样与隐私级别）
- [x] Prometheus metrics（`metrics/metrics.ts`：请求数、延迟、token、成本、上游错误、熔断状态、MCP、限流、插件拦截、guardrail 检测）
- [x] 请求日志（结构化 JSON 到 stdout + SQLite 请求日志库，供 `/admin/logs`）

### 3.8 配置
- [x] YAML / JSON 配置文件；`AI_GATEWAY_*` 环境变量覆盖（按 schema 解析）；`${VAR}` 引用
- [x] 严格配置校验（未知键、已移除键、交叉引用），`ai-gateway validate` 与启动共用
- [x] 模型别名
- [—] ~~热重载与配置写 API~~：0.2.0 移除；配置只来自文件，改完重启

### 3.9 持久化与认证
- [x] SQLite（`GATEWAY_DATA_DIR`）：密钥库（SHA-256 哈希、作用域、WAL、bootstrap 单向闩锁）、请求日志库、版本化迁移
- [x] `ADMIN_BOOTSTRAP_KEY` 仅用于首次启动；`GATEWAY_ENV=production` 启动安全检查

### 3.10 嵌入模式与 CLI
- [x] 可作为包导入：`new Gateway(config)` → `execute(surface)` / `executeStream(surface)`，以及 `route` / `routeStream` / `embed` 等包装；`createApp`、`bootstrap`
- [x] CLI：`ai-gateway serve | validate | keys (create | list | revoke) | version`

### 3.11 打包与发布
- [x] Dockerfile（非 root、tini、`/livez` 健康检查）+ CI 冒烟
- [x] 打 tag `vX.Y.Z` 发布：GHCR 多架构镜像、`bun build --compile` 的 5 平台二进制 + SHA256SUMS
- [x] 发布流程：同时改 `package.json` 与 `src/version.ts` 的版本号，给 CHANGELOG 的版本节写上日期，推送 tag

## 4. 项目结构

当前目录结构（含每个文件的职责）见 README.md 的 “Project Structure” 一节（README_CN.md 的“项目结构”）。顶层：

```
src/            源码（core/、routing/、providers/、plugins/、handlers/、middleware/、admin/、dashboard/、
                persistence/、auth/、config/、cli/、server/、mcp/、proxy/、observability/、metrics/）
tests/          unit/、integration/、regressions/、e2e/
scripts/        docker-smoke.sh、binary-smoke.sh、build-binaries.sh、release-notes.sh
.github/        ci.yml、release.yml、audit.yml
config.example.yaml / config.example.json / Dockerfile / README.md / README_CN.md / CHANGELOG.md / LICENSE / NOTICE
```

## 5. 已完成阶段

### 初始重写（Phase 1–11）— 已完成
1. ✅ 项目骨架 + 核心类型
2. ✅ 通用 OpenAI-compatible Provider（适配器、SSE 解析、能力矩阵）
3. ✅ Provider Registry + 全部 provider（0.2.0 改为一张预设表）
4. ✅ 路由策略（最初 8 种，0.2.0 收窄为 4 种）
5. ✅ 插件系统
6. ✅ Gateway 核心（0.2.0 改为 `core/pipeline.ts` + `core/executor.ts`，`gateway.ts` 只是门面）
7. ✅ HTTP 层（Hono + 中间件链 + handlers）
8. ✅ MCP Agentic Loop
9. ✅ 可观测性
10. ✅ 配置 + CLI + Admin（热重载在 0.2.0 移除）
11. ✅ 集成测试 + Docker

### 0.2.0 重构与加固 — 已完成（详见 CHANGELOG.md 0.2.0）
- ✅ Phase 0：e2e 契约测试 + openai SDK、导入 round-3 bug 复现、Dockerfile + CI 冒烟
- ✅ 1.x 收窄范围：4 种策略、删除死代码（logger、MCP http、exporter 注册表、内置 Tracer、内存 metrics）、一张 provider 预设表 + 兼容性模式、一个 CLI + 一个 `bootstrap()`
- ✅ 2.x 核心重构：统一错误模型（2.1）、executor（2.2）、pipeline 单次 finalize（2.3）、embeddings/images（2.4）、stream-runner（2.5）、completions wire 格式与字段透传（2.6）、MCP loop（2.7）、透传白名单（2.8）、门面化 + tests typecheck（2.9）
- ✅ 3.x 加固：MCP 重连、配置脱敏、word-filter NFKC、rate-limit 固定窗口、budget 预留/结算、关闭排空、严格配置校验、按 IP 限流修复
- ✅ 0.2.0 收尾：Apache-2.0 LICENSE + NOTICE、真正的管理控制台、pii-secret-guard、bootstrap 闩锁 + `keys` CLI、tag 驱动的发布流水线
- ✅ `tests/regressions/` 中导入的复现已全部修复，不再有 `it.failing`

## 6. 待办 / 已知问题（下一版本）

以下问题在核对文档与代码时发现，尚未修复（修复时同步更新 README 与 CHANGELOG）：

- [ ] `requestTimeout` 的 schema 允许 `500ms`，但 `middleware/request-timeout.ts` 的 `parseGoDuration` 没有 `ms` 单位，`500ms` 会被解析成 500 分钟；同时 schema 不接受 `1m30s` 这类组合写法（`tracing.shutdownGrace` 用的是另一个解析器）
- [ ] `observability.tracing.otlpProtocol: grpc` 被接受但不起作用（只有 OTLP/HTTP exporter）：要么实现 gRPC，要么从 schema 移除
- [ ] `targets[].priority`、`targets[].budget` 被 schema 接受但没有任何代码读取
- [ ] 插件 `config` 不做严格校验（pii-secret-guard 除外），例如 word-filter 的 `caseSensitive`、max-token 的 `maxMessages` 会被静默忽略
- [ ] 插件条目的 `stage` 必填但不起作用（内置插件自行决定阶段），`type` 也不起作用
- [ ] MCP `maxCallDepth` 只取第一个 `mcpServers` 条目的值
- [ ] `src/dashboard/static/dashboard.js`、`style.css` 是旧占位 dashboard 的遗留文件，已不再被服务，可删除
- [ ] `abtest` 废弃别名计划在 0.3.0 删除

## 7. 降级策略（防止卡住）

| 如果卡在 | 降级为 |
|---|---|
| 某个功能实现复杂 | 先做最小可用版本，其余记录到第 6 节 |
| 某个 provider 行为异常 | 先跳过该 provider，记录 issue |
| OTel 集成报错 | 先只做 console log，OTel 记录到第 6 节 |
| 任何问题超过 15 分钟没解决 | 降级 + 记录 + 继续下一项 |

## 8. 不做的事

- ❌ Anthropic/Gemini/Bedrock/Cohere/Vertex AI 协议翻译
- ❌ PostgreSQL 后端（只用 SQLite）
- ❌ 完整 Dashboard UI（只有精简管理控制台：概览、密钥、日志、只读配置）
- ❌ 配置热重载 / 运行时配置写 API（0.2.0 有意移除）
- ❌ 性能压测优化
- （原计划中的 “不做单二进制编译” 已改变：0.2.0 起发布 `bun build --compile` 二进制）
