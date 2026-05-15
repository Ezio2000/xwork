# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

xwork 是一个自托管的 AI 聊天服务，兼容 Anthropic Messages API 协议。支持多渠道/多模型配置、自动工具调用循环、SSE 流式响应。使用纯 Node.js ESM，无构建步骤。

## 常用命令

```bash
npm start          # 生产启动 (端口 3000)
npm run dev        # 开发模式 (node --watch 自动重启)
node --test        # 运行测试 (Node.js 内置 test runner)
node --test --test-name-pattern="queryLoop*"  # 运行匹配名称的测试
```

## 核心架构

### 数据流：一次聊天请求的完整路径

```
POST /api/v1/chat (SSE)
  → server.mjs 解析请求，加载渠道配置
  → queryLoop() 多轮工具调用循环 (lib/query-loop.mjs)
    → streamChat() 调用 Anthropic Messages API (lib/api.mjs)
    → runTool() 本地工具执行 (lib/tools/runner.mjs)
    → SSE 事件 → 前端 app.js 渲染
  → 对话持久化到 data/conversations/ (lib/storage.mjs)
```

### 关键模块

| 文件 | 职责 |
|---|---|
| `server.mjs` | Express 路由、渠道 CRUD、对话管理、SSE 流式主控制器 |
| `lib/api.mjs` | Anthropic Messages SSE 流客户端：解析 SSE 块、构建 system prompt、消息规范化、`assistantMessage()` 结果打包 |
| `lib/query-loop.mjs` | 多轮工具调用生成器：while(true) 模式，最多 maxTurns 轮，每轮执行 API 调用 → 收集 toolCalls → 执行工具 → 回传 tool_result → 继续 |
| `lib/storage.mjs` | 对话持久化：JSON 文件存储于 `data/conversations/` |
| `lib/tools/runner.mjs` | 工具执行引擎：生命周期钩子 (validate → before → handler → after → onComplete) + parseResult + 超时保护 |
| `lib/tools/registry.mjs` | 工具注册：读取 `data/tools.json` 配置，导出启用的工具定义给 API |
| `lib/tools/store.mjs` | 工具配置持久化到 `data/tools.json` |
| `lib/tools/runs.mjs` | 工具运行记录，写入 `data/tool-runs.json`（最近 200 条） |

### 工具系统

所有工具定义在 `lib/tools/builtin/` 下，需在 `index.mjs` 中注册。

两种适配器类型：
- **`builtin`**：本地执行，提供完整生命周期钩子 (validate/before/handler/after/onError/onComplete) 和 parseResult 渲染扩展
- **`anthropic_server`**：由 API 提供商（Anthropic）执行，通过 `parseStreamResult(block)` 解析 SSE 流中的结果块

### 前端

`public/` 目录为纯静态文件（无框架）：`index.html` + `app.js` + `markdown-it` + `style.css`。前端通过 EventSource/fetch SSE 消费 `/api/v1/chat` 流，按 `blocks` 数组渲染文本块和来源卡片。

### 配置

`config.json`：渠道列表（id/name/baseUrl/apiKey/models/maxTokens/extraHeaders）、activeChannelId、activeModel。通过 `/api/v1/channels` REST API 管理，API Key 在响应中自动掩码。

### 测试

单一测试文件 `test/query-loop.test.mjs`，使用 `node:test` + `node:assert/strict`。通过 mock factory 注入 `streamChat` 和 `runTool`，覆盖纯文本、单工具、多工具、多轮、maxTurns、abort、错误、混合 server/local 工具等场景。
