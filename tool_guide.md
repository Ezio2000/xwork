# Tool 开发指南

本文档按当前代码实现维护。核心代码位于 `lib/tools/`，运行时事件常量位于 `lib/run-events.mjs`，工具配置和运行记录通过 SQLite 文档存储保存在 `data/xwork.sqlite` 中。

## 目录结构

```
lib/tools/
├── builtin/           ← 内置工具定义
│   ├── index.mjs      ← 异步加载内置工具：loadBuiltinTools()
│   ├── calculator.mjs
│   ├── current-time.mjs
│   ├── delegate-task.mjs
│   ├── mysql-query.mjs
│   ├── shell-command.mjs
│   ├── sqlite-query.mjs
│   ├── uuid-gen.mjs
│   ├── web-fetch.mjs
│   └── web-search.mjs
├── runner.mjs         ← builtin 工具执行引擎（生命周期 + 超时 + parseResult + 运行记录）
├── registry.mjs       ← 工具注册读取 + 启用/禁用 + 配置合并
├── runs.mjs           ← 工具运行记录（SQLite document key: tool-runs，保留最近 200 条）
├── scheduler.mjs      ← 工具调用调度策略（顺序执行、parallel_batch、tool_delta 事件队列）
└── store.mjs          ← 工具配置持久化（SQLite document key: tools）

data/
└── xwork.sqlite       ← documents 表保存 tools / tool-runs 等文档，conversations 表保存会话
```

`data/` 不需要手动创建；`sqlite-store.mjs` 会在首次读写时自动创建目录和数据库。历史版本的 `data/tools.json`、`data/tool-runs.json` 仍会作为 legacy 文件读取并迁移到 SQLite document store。

---

## 定义一个 builtin 工具

最小工具定义：

```js
// lib/tools/builtin/my-tool.mjs
export const myTool = {
  id: 'my_tool',                  // 唯一标识，用于配置和运行记录
  name: 'my_tool',                // 给 AI 的函数名
  title: 'My Tool',               // 前端展示名
  description: 'What this tool does.',
  category: 'system',             // system / web / agent / ...
  adapter: 'builtin',             // builtin | anthropic_server
  version: '1.0.0',
  dangerLevel: 'low',             // low / medium / high
  defaultEnabled: true,
  timeoutMs: 5000,
  capabilities: {
    executionMode: 'sequential',   // sequential | parallel_batch
  },
  inputSchema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: '...' },
    },
    required: ['param1'],
    additionalProperties: false,
  },

  async handler(input, { config, context, signal, emit }) {
    // 核心逻辑
    emit?.({ stream: 'stdout', text: 'working...\n' }); // 可选：实时输出 tool_delta
    return { result: input.param1 };
  },
};
```

注册到 `lib/tools/builtin/index.mjs` 的 loader 列表：

```js
const builtinToolLoaders = [
  // ...
  ['my_tool', () => import('./my-tool.mjs'), 'myTool'],
];
```

当前不是静态导出 `builtinTools` 数组。`loadBuiltinTools()` 会异步加载 `builtinToolLoaders` 中的每个工具。如果某个工具加载失败，系统会生成一个 `adapter: 'unavailable'` 的占位工具，在工具列表中显示为不可用且默认禁用。

`capabilities.executionMode` 会影响 `lib/tools/scheduler.mjs` 的调度策略：

- `sequential`：默认模式，同一轮多个工具按顺序执行。
- `parallel_batch`：相邻且同名的工具调用会并行执行。当前 `delegate_task` 使用该模式，用于同时启动多个独立子代理。

---

## 适配器类型

### `adapter: 'builtin'`

由 `runner.mjs` 在本地执行。支持完整生命周期钩子、超时控制、AbortSignal、运行记录和 `parseResult`。

### `adapter: 'anthropic_server'`

由 API 提供商执行，不会进入 `runner.mjs`。`registry.mjs` 会把它转换为 Anthropic Messages API 的工具定义，并通过 `parseStreamResult` 从 SSE 内容块中提取渲染数据。

示例：

```js
{
  id: 'web_search',
  name: 'web_search',
  adapter: 'anthropic_server',
  apiToolType: 'web_search_20250305',
  maxUses: 4,
  systemPrompt: () => '策略提示词...',
  parseStreamResult(block) {
    return {
      renderType: 'source-cards',
      data: { sources, resultCount: sources.length, searchCount: 1 },
    };
  },
}
```

服务端工具事件处理链路：

```
Anthropic SSE block
  → lib/anthropic/client.mjs serverToolEvent()
  → tool.parseStreamResult(block)
  → lib/server-tool-events.mjs
  → SSE { type:'tool_result', tools:[{ renderType, data }] }
  → public/js/stream-reducer.js
```

### `adapter: 'unavailable'`

内部占位类型。工具 import 失败时由 `builtin/index.mjs` 自动生成。它会出现在 `/api/v1/tools` 返回结果中，但不会作为可执行工具传给模型。

---

## 模型工具调用约束

全局 system prompt 由 `lib/anthropic/message-normalizer.mjs` 的 `buildSystemPrompt()` 生成。当前约束是：

- 模型可以在同一轮 assistant response 中同时写文字和调用工具。
- 除非用户明确要求静默执行或不要说明，否则模型在任何工具调用前必须先输出一句简短进度说明，并且这句说明要放在同一轮 response 的工具调用之前。
- 独立工具调用可以在同一轮并行发出；有依赖关系的工具调用必须顺序执行。

这个约束只影响模型生成工具调用前的文本顺序，不改变后端工具执行器的调度规则。后端仍由 `query-loop.mjs` 和 `tools/scheduler.mjs` 根据模型返回的 `tool_use` 顺序执行。

---

## 生命周期钩子

仅 `builtin` 工具走以下流程。所有钩子都会收到同一类上下文对象：

```js
{ config, context, signal, emit }
```

- `config`：工具自定义配置，即工具配置中的 `config` 字段。
- `context`：本次运行上下文，例如 `conversationId`、`channelId`、`model`、`toolCallId`。
- `signal`：AbortSignal，用于请求中断或客户端停止时提前结束工作。
- `emit`：可选函数，用于在工具尚未完成时发出实时事件。当前主要给 `shell_command` 这类长耗时工具输出 `stdout` / `stderr` 增量。

执行顺序：

```
validate → before → handler → after → parseResult → onComplete
```

错误路径：

```
validate / before / handler / after 抛错 → onError → onComplete
```

`onComplete` 始终尝试触发，且不会把错误抛回调用方。

### validate

```js
validate(input, { config, context, signal, emit }) {
  if (!input.query) throw new Error('query is required');
}
```

抛错即拒绝本次调用。

### before

```js
async before(input, { config, context, signal, emit }) {
  return { ...input, precision: config.precision ?? 12 };
}
```

返回值非 `undefined` 时会成为 `handler` 的 input。返回 `{ skipHandler: true, result }` 可跳过 `handler`，直接进入 `after`。

### handler

```js
async handler(input, { config, context, signal, emit }) {
  const result = doWork(input);
  return { input: input.param, result };
}
```

`runner.mjs` 会对 `handler` 施加 `Promise.race()` 超时保护，并监听 `signal` 中止执行。超时时间优先级：

```
SQLite tools 文档中的 timeoutMs → 工具定义 timeoutMs → 10000
```

### after

```js
after(input, output, { config, context, signal, emit }) {
  if (output && typeof output.result === 'number') {
    output.result = parseFloat(output.result.toPrecision(input.precision ?? 12));
  }
  return output;
}
```

默认行为是原样返回 `output`。

### onError

```js
async onError(err, input, { config, context, signal, emit }) {
  if (err.message.includes('timeout')) {
    return { fallback: true, message: 'Service unavailable' };
  }
  throw err;
}
```

`onError` 返回值会被视为成功输出；再次抛错才会把工具结果标记为失败。

### parseResult

```js
parseResult(output, input) {
  return {
    renderType: 'my-render-type',
    data: { result: output.result },
  };
}
```

`parseResult` 只在工具未报错时执行。返回值会被附加到工具结果的 `render` 字段，并通过 SSE 发送到前端。

### emit / tool_delta

长耗时工具可以在 `handler` 执行期间调用 `emit` 发出中间输出：

```js
async handler(input, { emit }) {
  emit?.({ stream: 'stdout', text: 'step 1\n' });
  emit?.({ stream: 'stderr', text: 'warning\n' });
  return { ok: true };
}
```

`query-loop.mjs` 会把这些事件包装成：

```js
{
  type: 'tool_delta',
  id: call.id,
  name: call.name,
  input: call.input || {},
  stream: 'stdout',
  text: 'step 1\n'
}
```

事件流转链路：

```
tool.handler emit()
  → runner.mjs hookCtx.emit
  → query-loop.mjs emitToolEvent()
  → scheduler.mjs createToolEventQueue()
  → request-runner.mjs emit SSE { type:'tool_delta', ... }
  → public/js/stream-reducer.js applyToolDelta()
```

当前前端只对 `shell_command` 的 `tool_delta` 做可见渲染：`stdout` 追加到 shell block 的 stdout，`stderr` 追加到 stderr，并保持该 block 展开。其他工具如果要使用实时增量，需要同步扩展前端 reducer 和 renderer。

### onComplete

```js
onComplete(outcome, durationMs) {
  console.log(`[my_tool] ${outcome.isError ? 'failed' : 'ok'} (${durationMs}ms)`);
}
```

`outcome` 结构：

```js
{ id, name, isError, input, output, durationMs, error? }
```

---

## 配置

工具配置存储在 `data/xwork.sqlite` 的 `documents` 表中，文档 key 为 `tools`。历史 `data/tools.json` 会在首次读取时作为 legacy 数据迁移来源。配置可通过 API 动态修改：

```js
{
  "id": "my_tool",
  "enabled": true,
  "timeoutMs": 5000,
  "config": { "precision": 12 },
  "updatedAt": "2026-05-15T..."
}
```

`readToolConfigs(tools)` 会把已有配置和工具定义合并：

- 新工具会自动补默认配置
- 已删除工具会从配置列表中移除
- 加载失败工具会强制 `enabled: false`
- `config` 必须是对象，否则会被重置为 `{}`

`PUT /api/v1/tools/:id` 使用 `validateToolConfigPatch()` 校验请求体：

- `enabled` 会被 `Boolean(value)` 转成布尔值
- `timeoutMs` 必须是 1 到 300000 之间的整数
- `config` 必须是普通对象

在钩子中通过 `{ config }` 访问自定义配置：

```js
async handler(input, { config }) {
  const precision = config.precision ?? 12;
}
```

---

## 运行记录

`runner.mjs` 会把 builtin 工具运行结果写入 `data/xwork.sqlite` 的 `documents` 表，文档 key 为 `tool-runs`。`server-tool-events.mjs` 也会把 provider-side server tool 结果写入同一个文档。历史 `data/tool-runs.json` 会在首次读取时作为 legacy 数据迁移来源。

单条记录包含：

```js
{
  runId,
  toolCallId,
  name,
  isError,
  input,
  output,
  durationMs,
  context,
  source,
  environment,
  createdAt
}
```

默认最多保留最近 200 条。测试运行会在查询时默认过滤，可通过 `includeTest=true` 查看。

如果调用 `runTool(call, context)` 时传入：

```js
{ persistToolRun: false }
```

本次工具运行不会写入 `tool-runs` 文档。

---

## 结果渲染

### builtin 工具实时渲染链路

```
model tool_use
  → query-loop yields { type:'tool_call', tools:[...] }
  → stream-reducer applyToolCall()
  → shell_command 会先创建 status:'running' 的 shell-command block

handler emit({ stream, text })            ← 可选，仅长耗时工具需要
  → query-loop yields { type:'tool_delta', id, name, stream, text }
  → request-runner emit SSE
  → stream-reducer applyToolDelta()
  → shell_command 追加 stdout/stderr 并保持展开

handler output
  → tool.parseResult(output, input)
  → query-loop yields { type:'tool_result', renderType, data }
  → chat-service/root-run-context emit SSE
  → public/js/stream-client.js
  → public/js/stream-reducer.js applyToolResult()
  → 新 block: stream.blocks.push({ type: renderType, ...data })
  → 或已有 block: shell_command 按 toolCallId 合并最终状态并折叠
  → public/js/renderers.js blockRenderers[type]()
  → public/style.css
```

`shell_command` 的特殊点：

- `tool_call` 到达时立即显示运行中的命令块，避免长命令期间界面空白。
- `tool_delta` 到达时追加实时 stdout/stderr，适合 `npm install` 这类持续输出的命令。
- `tool_result` 到达时合并最终 `exitCode`、`durationMs`、`truncated` 等字段，并默认折叠。
- 如果安全校验或超时发生在没有 shell 输出前，前端会把已存在的 running 块标记为 error，避免一直停在 running。

### anthropic_server 工具实时渲染链路

```
Anthropic SSE server tool result
  → tool.parseStreamResult(block)
  → server-tool-events emit SSE { type:'tool_result', tools:[...] }
  → public/js/stream-reducer.js applyToolResult()
  → renderers.js
```

### 历史消息渲染链路

会话保存时，`chat-service.mjs` 会把 `serverToolEvents`、`builtinToolResults` 和工具调用消息一起交给 `message-rendering.mjs`：

```
finalState
  → buildStoredMessages()
  → message-rendering.mjs buildRenderBlocks()
  → SQLite conversations 表中的 assistant.blocks
  → public/js/conversation-view.js / renderers.js
```

前端还保留了兼容逻辑：`message-blocks.js` 可以从历史 `tool_result` 内容中识别 `uuid-list`，也可以从 `web_search_tool_result` 内容中恢复 `source-cards`。

---

## 新增渲染类型

### 1. 后端：实现 parseResult

```js
parseResult(output, input) {
  return {
    renderType: 'my-render-type',
    data: {
      items: output.items,
      total: output.total,
    },
  };
}
```

### 2. 前端：注册 block renderer

在 `public/js/renderers.js` 中添加渲染函数，并注册到 `blockRenderers`：

```js
function renderMyBlock(block, collapsed = false) {
  return `
    <div class="my-block-toggle${collapsed ? ' collapsed' : ''}">
      <div class="my-block-toggle-header" data-toggle-parent>
        <span class="my-block-toggle-label">${escHtml(block.label)}</span>
        <span class="my-block-toggle-arrow">▾</span>
      </div>
      <div class="my-block-toggle-body">
        ${(block.items || []).map(item => `
          <div class="my-block-item">${escHtml(item)}</div>
        `).join('')}
      </div>
    </div>
  `;
}

const blockRenderers = {
  // ...已有条目
  'my-render-type': (block, collapsed) => renderMyBlock(block, block.collapsed ?? collapsed),
};
```

`data-toggle-parent` 的折叠交互由 `installRendererEventHandlers()` 统一处理，不需要额外绑定点击事件。

### 3. 前端：默认折叠

如果希望流式传输时默认折叠，在 `public/js/stream-reducer.js` 的 `applyToolResult()` 中增加类型：

```js
if (
  block.type === 'source-cards' ||
  block.type === 'sources' ||
  block.type === 'web-fetch' ||
  block.type === 'my-render-type'
) {
  block.collapsed = true;
}
```

注意：当前不是在 `chat-stream.js` 中处理默认折叠。

### 4. 前端：样式

在 `public/style.css` 添加样式。优先复用项目 CSS 变量，例如 `--accent`、`--border`、`--bg-secondary`、`--text-muted`。

---

## 现有渲染类型

| renderType | 来源 | 说明 |
|---|---|---|
| `source-cards` | `web_search` / 兼容 web search 结果 | 可折叠来源卡片列表 |
| `sources` | 兼容旧消息块 | 与 `source-cards` 使用同一渲染函数 |
| `uuid-list` | `uuid_gen` | UUID 列表 + 逐行/全部复制 |
| `subagent-run` | `delegate_task` / agent 事件 | 子代理运行状态、事件和结果 |
| `web-fetch` | `web_fetch` | 可折叠网页内容卡片（URL、状态码、内容预览） |
| `shell-command` | `shell_command` | 命令、cwd、stdout/stderr、退出码、耗时；支持 running / completed / error 状态 |
| `mysql-query` | `mysql_query` | MySQL 查询结果表格，隐藏连接密码等敏感配置 |
| `sqlite-query` | `sqlite_query` | SQLite 查询结果表格，路径受工作区限制 |

---

## 工具配置 API

所有路径都挂在 `/api/v1` 下。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/tools` | 列出所有工具及其配置 |
| PUT | `/api/v1/tools/:id` | 更新 `enabled` / `timeoutMs` / `config` |
| POST | `/api/v1/tools/:id/enable` | 启用工具 |
| POST | `/api/v1/tools/:id/disable` | 禁用工具 |
| GET | `/api/v1/tool-runs?limit=N` | 最近 N 条运行记录 |

`GET /api/v1/tool-runs` 支持查询参数：

| 参数 | 说明 |
|---|---|
| `limit` | 返回数量，范围 1-200，默认 50 |
| `source` | 按 `source` 或 `context.source` 过滤 |
| `environment` | 按 `environment` 或 `context.environment` 过滤 |
| `includeTest` | `1` 或 `true` 时包含测试运行记录 |

`PUT /api/v1/tools/:id` 的请求体示例：

```json
{
  "enabled": true,
  "timeoutMs": 5000,
  "config": {
    "precision": 12
  }
}
```

请求体可以只包含要修改的字段。未知字段会被忽略，不会写入配置文件。

---

## 新建工具 Checklist

1. 创建 `lib/tools/builtin/<name>.mjs`，导出工具对象
2. 在 `lib/tools/builtin/index.mjs` 的 `builtinToolLoaders` 中加入 loader
3. 如需自定义展示，实现 `parseResult`
4. 如需自定义展示，在 `public/js/renderers.js` 添加渲染函数并注册 `blockRenderers`
5. 如需流式默认折叠，在 `public/js/stream-reducer.js` 的 `applyToolResult()` 中添加类型条件
6. 如需运行中可见 UI，在 `applyToolCall()` 中为对应工具创建 running block
7. 如需实时增量输出，在后端 `handler` 调用 `emit()`，并在前端 `applyToolDelta()` 中追加到对应 block
8. 如需样式，在 `public/style.css` 添加对应 CSS
9. 重启服务，工具会自动同步到 SQLite `tools` 文档
10. 在 Tools 页面或 `/api/v1/tools` 确认工具已加载、启用状态正确

---

## 常见注意点

- `anthropic_server` 工具不会由 `runTool()` 执行；它们只会被传给 provider。
- `anthropic_server` 工具会被转换为 Anthropic 工具格式：`apiToolType/type` → `type`，`maxUses` → `max_uses`，`allowedDomains/blockedDomains` → `allowed_domains/blocked_domains`。
- `systemPrompt()` 不会随工具定义直接发送，而是在 `message-normalizer.mjs` 的 `buildSystemPrompt()` 中拼接进系统提示。
- `registry.getToolRuntime(name)` 对禁用工具、未知工具、`anthropic_server` 工具都会返回不可本地执行的结果。
- `getEnabledToolDefinitions()` 会过滤 `adapter: 'unavailable'`，但会保留 `anthropic_server` 工具给模型使用。
- `handler` 的返回对象会被 `formatToolOutput()` JSON 字符串化后作为 Anthropic `tool_result.content` 发回模型。
- `parseResult` 的返回数据只用于 UI 渲染，不会替代发给模型的工具输出。
- 新增工具字段应保持 JSON 可序列化，避免运行记录或会话保存失败。
