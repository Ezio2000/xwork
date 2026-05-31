# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

xwork 是一个自托管的 AI 聊天服务，兼容 Anthropic Messages API 协议。支持多渠道/多模型配置、自动工具调用循环、子代理委派、SSE 流式响应和后台运行重连。使用纯 Node.js ESM，无构建步骤，数据存储使用 SQLite (`data/xwork.sqlite`)。

## 常用命令

```bash
npm start           # 生产启动 (默认端口 3000，可通过 PORT 环境变量覆盖)
npm run dev         # 开发模式 (node --watch 自动重启)
npm test            # 运行所有测试 (Node.js 内置 test runner)
npx node --test --test-name-pattern="queryLoop*"  # 运行匹配名称的测试
```

## 核心架构

### 一次聊天请求的完整路径

```
POST /api/v1/chat (SSE)
  → chat-service.mjs 校验请求，启动后台 ChatRun
  → request-runner.mjs 加载渠道配置，构建 history，创建 RootRunContext
  → queryLoop() 多轮工具调用循环 (lib/query-loop.mjs)
    → AnthropicProvider.streamChat() 调用 API (lib/providers/anthropic-provider.mjs)
      → lib/anthropic/client.mjs 管理 SSE 流 + serverToolEvent 解析
      → lib/anthropic/message-normalizer.mjs 构建 system prompt + 工具定义转换
    → scheduler.mjs 策略化执行工具调用 (sequential / parallel_batch)
    → runTool() 本地工具执行 (lib/tools/runner.mjs，生命周期钩子 + 超时保护)
    → SSE 事件 → 前端 stream-reducer.js 累积 blocks → renderers.js 按 type 渲染
  → 对话持久化到 data/xwork.sqlite (conversations 表) + agent-runs.json
```

### 关键模块

| 文件 | 职责 |
|---|---|
| `server.mjs` | Express 启动入口：CORS、静态文件、路由挂载、workspace 初始化 |
| `lib/chat-service.mjs` | 聊天服务编排：校验请求、启动/订阅 ChatRun、SSE 写入、ask_user 响应处理 |
| `lib/chat-runs.mjs` | 后台 ChatRun 生命周期管理：启动/停止/订阅/SSE 重放（支持客户端断线重连后从 afterSeq 续流） |
| `lib/chat/request-runner.mjs` | 单次请求执行器：解析渠道配置、构建对话历史、创建 RootRunContext、驱动 queryLoop、保存会话 |
| `lib/chat/channel-config.mjs` | 运行时渠道配置解析：合并活跃渠道/模型、加载工具定义 |
| `lib/chat/conversation-turn.mjs` | 对话轮次管理：加载历史、追加用户消息、保存完成轮次 |
| `lib/chat/message-projector.mjs` | 消息投影：buildStoredMessages 将 finalState 转为可持久化的消息格式 |
| `lib/chat/expand-file-mentions.mjs` | 展开消息中的文件提及（@文件名），注入文件内容到消息历史 |
| `lib/query-loop.mjs` | 多轮工具调用生成器：while(true) 模式，最多 maxTurns 轮，yield TOOL_CALL/TOOL_RESULT/TOOL_DELTA/ASK_USER_PENDING 事件 |
| `lib/providers/provider-contract.mjs` | Provider 适配器契约定义（ProviderTurnResult 接口），queryLoop 仅依赖此契约 |
| `lib/providers/anthropic-provider.mjs` | Anthropic 协议适配器：将 provider-contract 映射到具体 SSE 流实现 |
| `lib/anthropic/client.mjs` | Anthropic SSE 流客户端：fetch + SSE 解析、serverToolEvent 识别、content block 收集 |
| `lib/anthropic/message-normalizer.mjs` | System prompt 构建（含工具 systemPrompt、workspace 上下文、进度说明约束）+ 消息规范化 + 工具定义转 Anthropic 格式 |
| `lib/anthropic/sse-parser.mjs` | 底层 SSE 字节流解析器（行缓冲区 + JSON 解析） |
| `lib/anthropic/assistant-message.mjs` | 将 finalState + auditTrace 打包为 assistant 消息结构 |
| `lib/storage.mjs` | 对话持久化：SQLite conversations 表 CRUD + 按 conversationId 排队串行写入 |
| `lib/sqlite-store.mjs` | 通用 SQLite 文档存储：documents 表（key-value JSON）+ conversations 表，自动建库建表，支持 legacy JSON 文件迁移 |
| `lib/config-store.mjs` | 应用配置存储：SQLite document key='config'，legacy 读取 config.json |
| `lib/run-events.mjs` | SSE 事件类型常量（RUN_EVENT_TYPES, AGENT_EVENT_TYPES）+ 事件工厂函数 |
| `lib/root-run-context.mjs` | 根级运行审计上下文：记录 toolCall/toolResult/subagent 事件，completed 时构建完整 audit trace |
| `lib/server-tool-events.mjs` | anthropic_server 工具结果事件封装，统一 SSE 输出 |
| `lib/sse-writer.mjs` | SSE 响应写入工具（startSse/writeSse/writeSseDone） |
| `lib/audit-trace.mjs` | 审计追踪构建：合并 toolCalls/toolResults/agentRuns 到可审计的消息结构 |
| `lib/message-rendering.mjs` | 消息渲染块构建：将 tool results + agent runs 序列化为前端 blocks |
| `lib/schema.mjs` | 请求/配置校验：chatRequest、channelPayload、toolConfigPatch、safeId |
| `lib/workspace-root.mjs` | 工作区根目录管理：动态切换、路径验证、变更监听 |
| `lib/workspace-files.mjs` | 工作区文件工具：安全路径解析、文件树浏览 |
| `lib/git-workspace.mjs` | Git 工作区操作：status/diff/log 等命令封装 |
| `lib/agents/subagent-runtime.mjs` | 子代理运行时：runSubagent() 使用受限工具集执行委托任务，支持深度/轮次/超时限制 |
| `lib/agents/runs.mjs` | 代理运行记录（agent-runs.json）：创建/追加事件/完成，支持 root + subagent |
| `lib/user-input-registry.mjs` | ask_user 交互注册表：等待用户响应、超时管理 |
| `lib/tools/_core/registry.mjs` | 工具注册：读取 SQLite 配置、合并工具定义与用户配置、导出启用工具给 API |
| `lib/tools/_core/runner.mjs` | builtin 工具执行引擎：生命周期钩子 (validate→before→handler→after→onComplete) + parseResult + 超时 + 运行记录 |
| `lib/tools/loader.mjs` | 自动扫描 `lib/tools/<slug>/index.mjs` 加载 tool package |
| `lib/tools/ui-manifest.mjs` | 汇总各 tool 的 ui/stream/assets 路由，供前端动态加载 |
| `lib/tools/_core/scheduler.mjs` | 工具调度策略：根据 capabilities.executionMode 决定 sequential 或 parallel_batch 执行 |
| `lib/tools/_core/store.mjs` | 工具配置持久化到 SQLite documents key='tools' |
| `lib/tools/_core/runs.mjs` | 工具运行记录，写入 SQLite documents key='tool-runs'（最近 200 条） |
| `lib/model-pricing.mjs` | 模型定价计算：findEffectiveModelPricing + calculateUsageCost |
| `lib/pricing-store.mjs` | 定价数据存储（model-pricing.json） |
| `lib/usage-report.mjs` | Token 用量汇总报告：按 run/task/role/model 分组统计输入/输出/cache/成本 |

### 路由模块

`routes/index.mjs` 聚合以下路由（挂载到 `/api/v1`）：

| 路由文件 | 路径 | 职责 |
|---|---|---|
| `routes/channel-routes.mjs` | `/channels`, `/active` | 渠道 CRUD + 活跃渠道/模型切换 |
| `routes/chat-routes.mjs` | `/chat`, `/chat-runs/:id/stream`, `/chat-runs/:id/status` | 聊天 SSE + 后台运行重连 + ask_user 响应 |
| `routes/conversation-routes.mjs` | `/conversations` | 对话 CRUD |
| `routes/tool-routes.mjs` | `/tools`, `/tool-runs`, `/tools/ui-manifest` | 工具配置 + 运行记录 + UI manifest |
| `routes/expert-agent-routes.mjs` | `/expert-agents` | 专家 agent 配置 CRUD + 内置专家 reset |
| `routes/agent-routes.mjs` | `/agent-runs` | 代理运行记录查询 |
| `routes/usage-routes.mjs` | `/usage` | Token 用量与费用报表 |
| `routes/pricing-routes.mjs` | `/pricing` | 模型定价数据管理 |
| `routes/workspace-routes.mjs` | `/workspace` | 工作区根目录读写 |

### 工具系统

每个 tool 是一个独立 package，位于 `lib/tools/<slug>/`（如 `read-file/`、`shell-command/`）。`loader.mjs` 自动扫描并加载各文件夹的 `index.mjs`（导出 `export const tool`）。运行时核心在 `_core/`，跨工具共享代码在 `_shared/`。

> 注意：`lib/tools/` 根目录下的 `registry.mjs` / `runner.mjs` / `scheduler.mjs` / `store.mjs` / `runs.mjs` / `budget.mjs` / `main-agent-tools.mjs` 均为 `export * from './_core/...'` 的兼容 shim，真正实现在 `_core/` 下。新代码应直接 import `_core/`。

`_core/` 关键模块：`registry.mjs`（工具注册 + API 定义生成）、`runner.mjs`（builtin 生命周期执行引擎）、`scheduler.mjs`（执行策略）、`store.mjs`（配置持久化）、`runs.mjs`（运行记录）、`budget.mjs`（maxUses 预算计算）、`main-agent-tools.mjs`（主 agent 可用工具集筛选）。
`_shared/` 跨工具共享：`feishu-oauth.mjs`（飞书 OAuth）、`workspace-exploration-prompt.mjs`（探索类工具共享的 prompt 片段）、`styles/`（共享 CSS）。

当前 19 个 tool：`get_current_time`, `web_search`, `calculator`, `uuid_gen`, `delegate_task`, `web_fetch`, `read_file`, `write_file`, `code_outline`, `grep`, `glob`, `list_dir`, `git`, `shell_command`, `browser_action`, `ask_user`, `feishu_auth`, `feishu_read`, `about_xwork`

每个 tool package 可包含：
- `index.mjs`（必填）— 工具定义与 handler
- `ui.mjs`（可选）— 前端 block 渲染（`renderType` + `renderBlock`）
- `stream.mjs`（可选）— SSE 流式行为（`onToolCall` / `onToolDelta` / `onToolResult`）
- `client.mjs`（可选）— 浏览器交互客户端
- `assets.mjs`（可选）— 额外 API 路由
- `styles.css` / `test.mjs`（可选）

两种适配器类型：
- **`builtin`**：本地执行，提供完整生命周期钩子 (validate/before/handler/after/onError/onComplete) 和 `parseResult(output)` 返回 `{ renderType, data }`
- **`anthropic_server`**：由 API 提供商执行，通过 `parseStreamResult(block)` 返回 `{ renderType, data }`

工具运行时定义改写（`runtimeContext` + `resolveDefinition`，见 `package-contract.mjs`）：框架对工具名保持中立，工具可声明 `tool.runtimeContext: string[]`（如 `['expertAgents']`）并实现 `tool.resolveDefinition(definition, runtimeContext)` 在请求时改写自己的 API-facing description/inputSchema。`registry.mjs` 只懒加载已启用工具实际声明的 runtime-context key（loader 在 `RUNTIME_CONTEXT_LOADERS` 中注册）。典型用例：`delegate_task` 把专家 agent 目录注入到 description 和 `expertAgentId` enum。**注意**：改写产物会进入上游请求体，须保持字节稳定（拼接顺序、key/enum 顺序一致）以命中 provider 前缀缓存。

工具执行调度由 `lib/tools/_core/scheduler.mjs` 管理：
- `sequential`（默认）：同一轮多个工具按顺序执行
- `parallel_batch`：相邻且同名的工具调用并行执行（当前仅 `delegate_task` 使用）

两种适配器的 `{ renderType, data }` 通过统一管道流动：
  - 实时 SSE 流：前端 `stream-reducer.js` → `tool-stream-registry.js` 委托各 tool/stream.mjs
  - 保存对话：`message-rendering.mjs` 的 `buildRenderBlocks()` 统一输出
  - 渲染：`tool-ui-registry.js` 动态加载各 tool/ui.mjs，与 `renderers.js` 通用渲染合并
新增具备自定义渲染的 tool 只需在 package 内实现 `parseResult`/`parseStreamResult` + `ui.mjs`（及可选 `stream.mjs`）。

### 专家 agent / 子代理系统

`lib/agents/profiles.mjs` 管理 Expert Agent profiles，内置 `general_task_agent` 和一组 `xwork_*` 场景专家（定义在 `lib/agents/builtin-profiles.mjs`），用户可通过 `/expert-agents` 创建自定义专家或重置内置专家。
`lib/agents/subagent-runtime.mjs` 提供 `runSubagent()`：
- 按 `expertAgentId` 加载专家 profile，合并默认工具、模型偏好、轮次、超时、输出限制
- 默认通用专家最大深度 2 层、30 轮、90s 超时、输出截断 2000 字符；场景专家按用途收窄工具权限和轮次预算
- 专家 agent 调用 `queryLoop` 独立执行，结果通过 AGENT_EVENT_TYPES 事件通知根运行
- 专家 agent 输出截断后追加到父消息历史，避免上下文膨胀

### 工作区系统

`lib/workspace-root.mjs` 管理动态工作区根目录：
- 默认工作区 = xwork 项目根
- 可通过 `config.json` 的 `workspace.root` 或 `PUT /api/v1/workspace` 切换到任意目录
- 文件类工具（read_file, write_file, grep, glob, list_dir, git, shell_command）解析相对路径时基于当前工作区根
- 工作区变更会触发 `onWorkspaceChange` 监听器

### 前端

`public/` 目录为纯静态文件（无框架）：`index.html` + `app.js` + `markdown-it` + `style.css`。架构为 MVC 模式：
- `public/js/stores/app-store.js` — 全局状态存储
- `public/js/stream-client.js` + `public/js/stream-reducer.js` — SSE 流消费与响应式状态更新
- `public/js/tool-ui-registry.js` — 启动时拉 ui-manifest，动态 import 各 tool/ui.mjs
- `public/js/tool-stream-registry.js` — tool 流式事件分发给各 tool/stream.mjs
- `public/js/renderers.js` — 通用渲染（markdown/mermaid 等）+ 合并 registry 的 blockRenderers
- `public/js/controllers/` — 各页面控制器（chat-input, channels, tools, conversations, settings, pricing, usage, workspace, file-mention）
- `public/js/views.js` — 视图渲染工具
- `public/js/message-blocks.js` — 历史消息 blocks 兼容恢复
- `public/js/ask-user-client.js` — ask_user 交互弹窗
- `public/js/tool-block-collapse.js` — 工具块折叠/展开交互

### 配置

`config.json`（兼容格式）→ SQLite documents key='config'：渠道列表（id/name/baseUrl/apiKey/models/maxTokens/maxTurns/extraHeaders/pricing）、activeChannelId、activeModel、workspace。通过 REST API 管理，API Key 在响应中自动掩码。

### 存储

所有数据存储在 `data/` 目录：
- `data/xwork.sqlite` — 主数据库（documents 表: config/tools/tool-runs 等；conversations 表: 对话消息）
- `data/agent-runs.json` — 代理运行记录
- `data/model-pricing.json` — 模型定价基准数据
- 数据目录在首次读写时自动创建，历史 JSON 文件作为 legacy 数据迁移来源

### 测试

22+ 个测试文件，使用 `node:test` + `node:assert/strict`。工具相关测试优先放在 `lib/tools/<slug>/test.mjs`（colocated），`test/*.test.mjs` 保留集成测试或 re-export shim。核心测试：
- `test/query-loop.test.mjs` — queryLoop 引擎（mock streamChat + runTool，覆盖纯文本/单工具/多工具/多轮/maxTurns/abort/错误/混合 server+local 工具）
- `test/architecture.test.mjs` — 架构安全契约（事件常量、system prompt、工具调度策略、对话排队、后台运行、审计追踪、用量报表、定价匹配）
- `test/subagent.test.mjs` — 子代理执行与限制
- `test/tool-runner.test.mjs` — 工具生命周期钩子
- `test/chat-runs.test.mjs` — 后台运行管理
- `lib/tools/ask-user/test.mjs` — ask_user 交互流程
- `test/expand-file-mentions.test.mjs` — 文件提及展开
- `lib/tools/grep/test.mjs`, `lib/tools/read-file/test.mjs`, `lib/tools/write-file/test.mjs`, `lib/tools/list-dir/test.mjs` — 工作区工具
- `lib/tools/browser-action/test.mjs`, `lib/tools/code-outline/test.mjs`, `lib/tools/feishu-auth/test.mjs`, `lib/tools/feishu-read/test.mjs` — 其余 colocated 工具测试
- `test/tool-budget.test.mjs` — 工具 maxUses 预算；`test/expert-agents.test.mjs` — 专家 agent 配置
- `test/frontend-modules.test.mjs` — 前端模块完整性
- 通过 `CHAT_SERVICE_TEST_HOOKS` 可注入 mock `streamChat` 和 `runTool`

### Provider 抽象

`lib/providers/provider-contract.mjs` 定义了 `ProviderTurnResult` 接口，queryLoop 仅依赖此契约而非具体供应商。`lib/providers/anthropic-provider.mjs` 是当前实现，未来可扩展其他供应商适配器。
