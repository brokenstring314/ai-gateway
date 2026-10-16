# AI Gateway Rewrite — 任务计划

> **此文件是所有后续 AI 工作的唯一权威参考。每次开始工作前必读此文件，严格按计划执行，不得偏离。**

## 1. 项目定义

| 项 | 值 |
|---|---|
| **目标** | 用 TypeScript 重写 ai-gateway，只兼容 OpenAI 兼容协议 |
| **原项目路径** | `/mnt/d/Workspace/Lab/AIChat/ImportResource/ai-gateway/` |
| **新项目路径** | `/mnt/d/Workspace/Lab/AIChat/ai-gateway-rewrite/` |
| **运行时** | Bun 1.3+ |
| **框架** | Hono (多运行时兼容，28k⭐，9.3M 周下载) |
| **验证** | Zod (schema 即验证即类型) |
| **测试** | bun test（Vitest 兼容 API，从 `bun:test` 导入） |
| **语言** | TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess`, `noImplicitOverride`) |

## 2. 核心约束（不可违反）

1. **只兼容 OpenAI 兼容协议** — 不做 Anthropic/Gemini/Bedrock/Cohere/Vertex AI 翻译层
2. **无安全漏洞** — 输入验证用 Zod，API key 不入日志，请求体大小限制，CORS 可配置，安全头默认开启
3. **高度可测试** — 每个模块必须有单元测试，核心流程有集成测试，mock 友好的接口设计
4. **功能全面对齐** — 原项目有的功能，重写版必须有（见第 4 节功能清单）
5. **完全可用** — 必须能 `bun run` 启动，用 curl/OpenAI SDK 实际调用成功
6. **性能不差太多** — LLM gateway 瓶颈在 upstream，网关自身延迟 <5ms 即可
7. **不卡住** — 遇到解决不了的问题立即降级/简化，记录在案，继续推进，绝不循环

## 3. 原项目功能清单（必须对齐）

### 3.1 Provider 系统
- [x] `IProvider` 接口：`name`, `complete()`, `supportedModels()`, `supportsModel()`
- [x] `IStreamProvider` 接口：`completeStream()` 返回 SSE 流
- [x] `IEmbeddingProvider` 接口：`embed()`
- [x] `IImageProvider` 接口：`generateImage()`
- [x] `IDiscoveryProvider` 接口：`discoverModels()` 从 provider API 动态获取模型列表
- [x] Provider Registry：注册、查找、按模型查找
- [x] 通用 OpenAI-compatible 适配器（一个实现覆盖全部 20 个 provider）
- [x] 20 个 provider 配置：openai, deepseek, groq, mistral, xai, qwen, moonshot, together, fireworks, deepinfra, ai21, cerebras, sambanova, novita, nvidia_nim, ollama, openrouter, perplexity, replicate, cloudflare, databricks, huggingface
- [x] 每个 provider 的 capabilities 声明（支持/不支持哪些参数）
- [x] 兼容性模式：warn / drop / reject（对 provider 不支持的参数）

### 3.2 路由策略（8 种）
- [x] Single — 固定路由到一个 target
- [x] Fallback — 按顺序尝试，失败则下一个
- [x] LoadBalance — 按权重分配
- [x] Conditional — 根据请求字段匹配规则路由
- [x] LeastLatency — 路由到 p50 延迟最低的 target
- [x] CostOptimized — 路由到最便宜的 target
- [x] ContentBased — 根据提示内容路由
- [x] ABTest — 加权随机分流

### 3.3 插件系统
- [x] 插件生命周期：`beforeRequest` / `afterRequest` / `onError`
- [x] 插件管理器：注册、执行链、短路返回
- [x] 内置插件：
  - [x] RateLimit — 按 API key 限流
  - [x] Cache — 响应缓存（内存）
  - [x] Logger — 请求/响应日志
  - [x] WordFilter — 内容过滤
  - [x] MaxToken — token 上限限制
  - [x] Budget — 预算控制

### 3.4 MCP (Model Context Protocol)
- [x] MCP Server 配置（stdio / HTTP）
- [x] 工具发现：从 MCP server 获取工具列表
- [x] 工具注入：将 MCP 工具定义注入 chat completion 请求
- [x] Agentic loop：LLM 返回 tool_calls 时自动执行，循环直到无 tool_calls 或达深度限制
- [x] 工具调用审计钩子

### 3.5 API 端点
- [x] `POST /v1/chat/completions` — 非流式 + 流式 SSE
- [x] `POST /v1/completions` — legacy completions
- [x] `POST /v1/embeddings` — embedding
- [x] `POST /v1/images/generations` — 图片生成
- [x] `GET /v1/models` — 模型列表
- [x] `GET /health` — 健康检查
- [x] Admin API：配置 CRUD、API key 管理、日志查看

### 3.6 中间件
- [x] 请求体大小限制（默认 10MB）
- [x] CORS（可配置）
- [x] API Key 认证（Bearer token）
- [x] 安全头（X-Content-Type-Options, X-Frame-Options 等）
- [x] Panic 恢复
- [x] 请求超时

### 3.7 可观测性
- [x] OpenTelemetry tracing（请求 span、provider span、插件 span）
- [x] OTLP exporter（gRPC / HTTP）
- [x] Prometheus metrics（请求计数、延迟直方图、token 用量）
- [x] 请求日志（结构化 JSON）

### 3.8 配置
- [x] YAML / JSON 配置文件
- [x] 环境变量覆盖
- [x] 热重载（配置变更后自动生效）
- [x] 配置验证（Zod schema）
- [x] 模型别名（friendly name → model ID）

### 3.9 嵌入模式
- [x] 可作为 npm 包导入，编程式创建 Gateway 实例
- [x] `new Gateway(config)` → `gateway.route(request)` / `gateway.routeStream(request)`

### 3.10 CLI
- [x] `ai-gateway serve` — 启动服务
- [x] `ai-gateway validate` — 验证配置文件
- [x] `ai-gateway version` — 版本信息

## 4. 项目结构

```
ai-gateway-rewrite/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── src/
│   ├── index.ts                    # 入口 + 嵌入模式导出
│   ├── gateway.ts                  # Gateway 核心类
│   ├── config/
│   │   ├── schema.ts               # Zod 配置 schema
│   │   ├── loader.ts               # YAML/JSON/env 配置加载
│   │   └── types.ts                # 配置类型导出
│   ├── providers/
│   │   ├── types.ts                # IProvider 等接口定义
│   │   ├── registry.ts             # Provider 注册表
│   │   ├── openai-compat.ts        # 通用 OpenAI-compatible 适配器
│   │   ├── capabilities.ts         # Provider 能力矩阵
│   │   ├── sse-parser.ts           # SSE 流解析器
│   │   └── definitions/            # 20 个 provider 配置定义
│   │       ├── openai.ts
│   │       ├── deepseek.ts
│   │       ├── groq.ts
│   │       └── ...（每个一个文件）
│   ├── routing/
│   │   ├── types.ts                # IStrategy 接口
│   │   ├── single.ts
│   │   ├── fallback.ts
│   │   ├── loadbalance.ts
│   │   ├── conditional.ts
│   │   ├── least-latency.ts
│   │   ├── cost-optimized.ts
│   │   ├── content-based.ts
│   │   └── abtest.ts
│   ├── plugins/
│   │   ├── types.ts                # IPlugin, Stage, PluginContext
│   │   ├── manager.ts              # 插件管理器
│   │   └── builtins/               # 内置插件
│   │       ├── rate-limit.ts
│   │       ├── cache.ts
│   │       ├── logger.ts
│   │       ├── word-filter.ts
│   │       ├── max-token.ts
│   │       └── budget.ts
│   ├── mcp/
│   │   ├── client.ts               # MCP 客户端
│   │   ├── executor.ts             # Agentic tool-call loop
│   │   └── types.ts                # MCP 类型
│   ├── middleware/
│   │   ├── body-limit.ts
│   │   ├── cors.ts
│   │   ├── auth.ts
│   │   ├── security-headers.ts
│   │   ├── recover.ts
│   │   └── request-timeout.ts
│   ├── handlers/
│   │   ├── chat.ts                 # /v1/chat/completions
│   │   ├── completions.ts          # /v1/completions
│   │   ├── embeddings.ts           # /v1/embeddings
│   │   ├── images.ts               # /v1/images/generations
│   │   ├── models.ts               # /v1/models
│   │   └── health.ts               # /health
│   ├── observability/
│   │   ├── tracing.ts              # OTel tracing
│   │   ├── metrics.ts              # Prometheus metrics
│   │   └── request-log.ts          # 结构化请求日志
│   ├── admin/
│   │   ├── config-handlers.ts      # 配置 CRUD
│   │   ├── key-handlers.ts         # API key 管理
│   │   └── log-handlers.ts         # 日志查看
│   └── cli/
│       └── index.ts                # CLI 入口
├── tests/
│   ├── unit/                       # 单元测试（每个模块）
│   ├── integration/                # 集成测试（完整请求流）
│   └── fixtures/                   # 测试数据
├── config.example.yaml             # 示例配置
├── config.example.json             # 示例配置
├── Dockerfile
└── README.md
```

## 5. 执行阶段（严格按顺序）

### Phase 1: 项目骨架 + 核心类型（~30 min）
1. `bun init`，配置 tsconfig strict，安装依赖
2. 定义所有核心接口：`IProvider`, `IStreamProvider`, `IEmbeddingProvider`, `IImageProvider`, `IDiscoveryProvider`, `IStrategy`, `IPlugin`
3. 定义 Zod schema：Request, Response, StreamChunk, Config
4. 验证：`bun run typecheck` 通过

### Phase 2: 通用 OpenAI-compatible Provider（~45 min）
1. 实现 `openai-compat.ts`：通用 HTTP 请求构建 + 响应解码
2. 实现 `sse-parser.ts`：SSE 流解析
3. 实现 `capabilities.ts`：能力矩阵
4. 实现 3 个 provider 定义（openai, deepseek, groq）作为验证
5. 验证：单元测试通过，mock HTTP 测试 complete + completeStream

### Phase 3: Provider Registry + 全部 Provider 定义（~30 min）
1. 实现 `registry.ts`
2. 补齐剩余 17 个 provider 定义（纯配置，每个 ~20 行）
3. 验证：registry 查找测试通过

### Phase 4: 路由策略（~60 min）
1. 实现 `IStrategy` 接口 + `StrategyFactory`
2. 逐个实现 8 种策略，每种配单元测试
3. 验证：策略单元测试全部通过

### Phase 5: 插件系统（~45 min）
1. 实现 `PluginManager`：注册、执行链、短路
2. 实现 6 个内置插件，每个配单元测试
3. 验证：插件链测试通过

### Phase 6: Gateway 核心（~45 min）
1. 实现 `gateway.ts`：Route + RouteStream 主流程
2. 串联 Provider → Strategy → Plugin → MCP
3. 验证：集成测试（mock provider，完整请求流）

### Phase 7: HTTP 层（~45 min）
1. Hono app + 中间件链
2. 实现 6 个 handler（chat, completions, embeddings, images, models, health）
3. 验证：`bun run dev` 启动，curl 测试各端点

### Phase 8: MCP Agentic Loop（~30 min）
1. MCP 客户端 + 工具发现
2. Agentic loop（tool_calls → 执行 → 再请求）
3. 验证：mock MCP server 集成测试

### Phase 9: 可观测性（~30 min）
1. OTel tracing 集成
2. Prometheus metrics
3. 结构化请求日志
4. 验证：metrics 端点可访问

### Phase 10: 配置 + CLI + Admin（~30 min）
1. YAML/JSON 配置加载 + 热重载
2. CLI 入口
3. Admin API
4. 验证：`ai-gateway serve -c config.yaml` 启动成功

### Phase 11: 集成测试 + Docker（~30 min）
1. 端到端集成测试
2. Dockerfile
3. 验证：Docker 构建运行，curl 完整流程通过

## 6. 降级策略（防止卡住）

| 如果卡在 | 降级为 |
|---|---|
| 某个路由策略实现复杂 | 先跳过，只实现 Single + Fallback + LoadBalance，其余标记 TODO |
| MCP agentic loop 复杂 | 先只做工具注入，不做自动循环 |
| OTel 集成报错 | 先只做 console log，OTel 标记 TODO |
| 某个 provider 行为异常 | 先跳过该 provider，记录 issue |
| 热重载实现复杂 | 先只做重启加载 |
| Admin API 复杂 | 先只做配置查看，CRUD 标记 TODO |
| 任何问题超过 15 分钟没解决 | 降级 + 记录 + 继续下一项 |

## 7. 不做的事

- ❌ Anthropic/Gemini/Bedrock/Cohere/Vertex AI 协议翻译
- ❌ Native AOT / 单二进制编译
- ❌ PostgreSQL 后端（先用内存/SQLite）
- ❌ Dashboard UI
- ❌ 性能压测优化
