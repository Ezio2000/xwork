# Tool 开发指南

本文档按当前代码实现维护。核心代码位于 `lib/tools/`，运行时事件常量位于 `lib/run-events.mjs`，工具配置和运行记录通过 SQLite 文档存储保存在 `data/xwork.sqlite` 中。

## 目录结构

```
lib/tools/
├── _core/                 ← 工具运行时（runner / registry / scheduler / store / runs / budget）
├── _shared/               ← 跨工具共享模块（workspace-exploration-prompt、feishu-oauth 等）
├── loader.mjs             ← 自动扫描 lib/tools/<slug>/index.mjs 并加载
├── ui-manifest.mjs        ← 汇总前端 ui/stream/assets 路由
├── package-contract.mjs   ← tool package 文件契约
├── calculator/            ← 每个工具一个文件夹
│   └── index.mjs
├── read-file/
│   ├── index.mjs          ← 必填：export const tool = { ... }
│   ├── ui.mjs             ← 可选：前端 block 渲染
│   ├── stream.mjs         ← 可选：SSE tool_call / tool_delta / tool_result 处理
│   ├── client.mjs         ← 可选：浏览器交互、对话页 header action、工具设置页扩展
│   ├── assets.mjs         ← 可选：registerRoutes(router) 挂载 API 路由
│   ├── styles.css         ← 可选：工具专属样式
│   └── test.mjs           ← 可选：node:test 用例
├── browser-action/
│   ├── index.mjs, ui.mjs, stream.mjs, cdp-session.mjs, assets.mjs, test.mjs
└── ...（其余 19 个 tool 同理）

lib/tools/runner.mjs       ← re-export shim → _core/runner.mjs
lib/tools/registry.mjs     ← re-export shim → _core/registry.mjs

public/js/
├── tool-ui-registry.js    ← 启动时拉 /tools/ui-manifest，动态 import 各 tool/ui.mjs
├── tool-stream-registry.js← 委托 tool stream 模块处理 tool_call/delta/result
└── renderers.js           ← 通用渲染（markdown/mermaid 等）+ 合并 registry 的 blockRenderers

data/
└── xwork.sqlite           ← documents 表保存 tools / tool-runs 等文档，conversations 表保存会话
```

`data/` 不需要手动创建；`sqlite-store.mjs` 会在首次读写时自动创建目录和数据库。历史版本的 `data/tools.json`、`data/tool-runs.json` 仍会作为 legacy 文件读取并迁移到 SQLite document store。

---

## 定义一个 builtin 工具

每个工具放在 `lib/tools/<slug>/` 文件夹中，文件夹名通常把 tool id 的下划线换成连字符（如 `read_file` → `read-file/`）。`loader.mjs` 会自动扫描并加载所有含 `index.mjs` 的子目录（跳过 `_core`、`_shared`）。

最小工具定义：

```js
// lib/tools/my-tool/index.mjs
export const tool = {
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

**无需手动注册。** 创建 `lib/tools/my-tool/index.mjs` 并导出 `tool` 后，`loadTools()` 会在下次启动时自动发现。如果某个工具加载失败，系统会生成一个 `adapter: 'unavailable'` 的占位工具，在工具列表中显示为不可用且默认禁用。

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

内部占位类型。工具 import 失败时由 `loader.mjs` 自动生成。它会出现在 `/api/v1/tools` 返回结果中，但不会作为可执行工具传给模型。

---

## 运行时定义改写（resolveDefinition）

普通工具的 `description` 和 `inputSchema` 是静态的。如果某个工具需要在**请求生成时**根据运行时数据动态改写自己的 API 定义（例如把当前可用的专家 agent 列表注入到 `description` 和参数 `enum` 中），可以使用以下两个**可选**契约，而**无需框架硬编码工具名**：

```js
export const tool = {
  // ...其余定义

  // 1. 声明需要哪些运行时数据。registry 只收集这里列出的 key 并传给 resolveDefinition。
  runtimeContext: ['expertAgents'],

  // 2. 在生成 API 定义时改写自己。返回新的 definition。
  resolveDefinition(definition, runtimeContext = {}) {
    const expertAgents = runtimeContext.expertAgents || [];
    return {
      ...definition,
      description: `${definition.description}${buildCatalog(expertAgents)}`,
      inputSchema: injectEnum(definition.inputSchema, expertAgents),
    };
  },
};
```

工作机制：

- `lib/tools/_core/registry.mjs` 的 `getEnabledToolDefinitions()` 先调用 `collectRuntimeContext()`，**惰性收集**所有已启用工具声明的 `runtimeContext` key（未被任何工具声明的 key 不会触发收集，避免无谓开销）。
- 当前支持的运行时上下文 key 由 `registry.mjs` 的 `RUNTIME_CONTEXT_LOADERS` 注册，目前仅 `expertAgents`（来自 `listEnabledExpertAgentsForPrompt()`）。新增上下文来源时在此处增加 loader。
- 每个工具的 `configuredToolDefinition()` 在拼好基础 definition 后，若工具实现了 `resolveDefinition` 就调用它，由工具返回最终 definition；未实现该钩子的工具行为完全不变。

> **缓存约束（重要）**：`resolveDefinition` 产出的 `description` 字符串和 `inputSchema` 对象会进入发往上游 API 的请求体。上游依赖**逐字节相同的前缀**命中缓存（参见 `message-normalizer.mjs` 的 prefix-cache 注释）。改写时必须保持**字节稳定**：相同的拼接顺序、相同的换行/空格、相同的对象 key 与 enum 数组顺序。否则会击穿前缀缓存、抬高成本。`test/architecture.test.mjs` 中有针对 `delegate_task` 的字节稳定性断言作为防回归。

**现有实例**：`delegate_task`（`lib/tools/delegate-task/index.mjs`）用 `resolveDefinition` 把可用专家 agent catalog 追加到 `description`，并把专家 id 注入 `expertAgentId` 参数的 `enum`；同时把 `expertAgents` 透传到 definition 上，供其 `systemPrompt(tool)` 渲染同一份 catalog。这部分逻辑过去硬编码在 `registry.mjs` 里，现已收口到工具自身，registry 不再认识任何具体工具名。

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
  → public/js/tool-stream-registry.js（各 tool/stream.mjs）
  → public/js/tool-ui-registry.js 动态加载的 blockRenderers[type]()
  → public/style.css（通用样式；可选 lib/tools/<slug>/styles.css）
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

在 `lib/tools/<slug>/ui.mjs` 中实现渲染函数并导出：

```js
// lib/tools/my-tool/ui.mjs
export const renderType = 'my-render-type';

export function renderBlock(block, collapsed = false, ctx) {
  // ctx 提供 escHtml、renderContent 等（由 renderers.js 传入）
  return `
    <div class="my-block-toggle${collapsed ? ' collapsed' : ''}">
      <div class="my-block-toggle-header" data-toggle-parent>
        <span class="my-block-toggle-label">${ctx.escHtml(block.label)}</span>
        <span class="my-block-toggle-arrow">▾</span>
      </div>
      <div class="my-block-toggle-body">
        ${(block.items || []).map(item => `
          <div class="my-block-item">${ctx.escHtml(item)}</div>
        `).join('')}
      </div>
    </div>
  `;
}
```

`app.js` 启动时会调用 `loadToolUiRegistry()`，通过 `GET /api/v1/tools/ui-manifest` 动态 import 各 tool 的 `ui.mjs` 并合并到 `blockRenderers`。`renderers.js` 保留 markdown/mermaid 等通用渲染，最终由 `renderBlocks()` 合并 core + registry。

`data-toggle-parent` 的折叠交互由 `installRendererEventHandlers()` 统一处理，不需要额外绑定点击事件。

### 3. 前端：block 行为元数据 / 流式行为

`ui.mjs` 除了 `renderType` / `renderBlock`，还可以声明 block 行为元数据：

```js
export const keepExpanded = true;        // 完成后也保持展开，并标记 fixedOpen
export const defaultCollapsed = false;   // 通用结果 block 初始折叠状态
```

这些元数据只绑定 `renderType` 和 `aliasRenderTypes`，不会绑定 `altRenderTypes`。例如 `feishu-read/ui.mjs` 的 `feishu-media` 会声明 `keepExpanded = true`，但它作为 `file-snippet` 的备用 renderer 时不会改变普通文件片段的折叠策略。

如需自定义 `tool_call`、`tool_delta` 或默认折叠逻辑，在 `lib/tools/<slug>/stream.mjs` 中导出对应钩子：

```js
export function onToolCall(stream, tool, evt) { /* 创建 running block */ }
export function onToolDelta(stream, tool, evt) { /* 追加增量输出 */ }
export function onToolResult(stream, tool, evt) { /* 合并最终状态、设置 collapsed */ }
```

`stream-reducer.js` 会把 tool 专用逻辑委托给 `tool-stream-registry.js` 加载的 stream 模块。无 stream 模块时，走通用 `applyToolCall` / `applyToolDelta` / `applyToolResult` 逻辑。

### 4. 前端：client 扩展点

在 `lib/tools/<slug>/client.mjs` 中可以导出浏览器侧扩展。`tool-ui-registry.js` 会随 manifest 动态 import，并把 `api`、`state`、`escHtml` 等上下文传给扩展函数。

```js
export const toolId = 'my_tool';
// 或 export const toolIds = ['my_tool', 'related_tool'];

export function renderHeaderActions(ctx) {
  return '<button type="button" class="btn-icon">…</button>';
}

export function installHeaderActionHandlers(root, ctx) {
  root.addEventListener('click', event => {
    // 处理 renderHeaderActions 贡献的 DOM
  });
}

export function renderConfigFields(tool, ctx) {
  return '';
}

export function editableConfig(tool, config) {
  return config;
}

export function normalizeConfigPayload(tool, payload, form, ctx) {
  return payload;
}
```

当前 Feishu 的对话页“飞”按钮、清 token API 调用、App ID/App Secret 配置字段都在 `lib/tools/feishu-auth/client.mjs` 中实现；公共工具设置页只提供表单骨架和这些扩展点。

### 5. 前端：样式

在 `lib/tools/<slug>/styles.css` 添加工具专属样式，由 `ui-manifest` 自动注入。共享折叠块样式（`shell-command-toggle`、`sources-toggle` 等）在 `lib/tools/_shared/styles/shell-toggle.css`。聊天页全局样式仍在 `public/style.css`。

### 6. 后端：tool 自带 API / asset 路由

如需为工具提供额外 HTTP 路由，在 `lib/tools/<slug>/assets.mjs` 中导出：

```js
export function registerRoutes(router) {
  router.get('/tool-assets/my-tool/:filename', async (req, res) => {
    // 返回工具生成的资源
  });
}
```

`routes/tool-routes.mjs` 会调用 `collectToolAssetRoutes()` 自动加载这些 registrar。路由仍挂在 `/api/v1` 下；如果在 registrar 中注册 `/tools/my_tool/action`，最终路径就是 `/api/v1/tools/my_tool/action`。

---

## 现有渲染类型

| renderType | 来源 | 说明 |
|---|---|---|
| `source-cards` | `web_search` / 兼容 web search 结果 | 可折叠来源卡片列表 |
| `sources` | 兼容旧消息块 | 与 `source-cards` 使用同一渲染函数 |
| `uuid-list` | `uuid_gen` | UUID 列表 + 逐行/全部复制 |
| `subagent-run` | `delegate_task` / agent 事件 | 子代理运行状态、事件和结果 |
| `web-fetch` | `web_fetch` | 可折叠网页内容卡片（URL、状态码、内容预览） |
| `browser-action` | `browser_action` | 浏览器动作结果（URL、标题、文本摘要、截图路径等） |
| `shell-command` | `shell_command` | 命令、cwd、stdout/stderr、退出码、耗时；支持 running / completed / error 状态 |

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

1. 创建 `lib/tools/<slug>/index.mjs`，导出 `export const tool = { ... }`
2. 如需自定义展示，在 `index.mjs` 实现 `parseResult`，并添加 `ui.mjs`（`renderType` + `renderBlock`）
3. 如需流式/running 块行为，添加 `stream.mjs`（`onToolCall` / `onToolDelta` / `onToolResult`）
4. 如需浏览器交互、对话页 header action 或工具设置页扩展，添加 `client.mjs`
5. 如需额外 API 路由（截图、媒体代理等），添加 `assets.mjs` 并实现 `registerRoutes(router)`
6. 如需在请求时按运行时数据动态改写自身定义，声明 `runtimeContext` 并实现 `resolveDefinition`（注意字节稳定性，见上文）
7. 如需样式，添加 `styles.css`
8. 添加 `test.mjs` 覆盖注册与 handler 行为
9. 重启服务，工具会自动同步到 SQLite `tools` 文档
10. 在 Tools 页面或 `/api/v1/tools` 确认工具已加载、启用状态正确
11. 在 `/api/v1/tools/ui-manifest` 确认前端 manifest 包含新 tool

---

## 常见注意点

- `browser_action` 基于 Playwright Chromium，默认禁用。它适合跨平台网页 UI 验证，截图写入 workspace 内的 `data/browser-screenshots`。建议优先配置 `allowedHosts`，例如只允许 `localhost` 和 `127.0.0.1`。
- `feishu_read` 默认禁用。它通过飞书 OpenAPI 只读获取新版文档、Docx block tree、文档图片/附件素材、旧版文档、电子表格元数据和范围值；建议用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 环境变量提供凭据，或在工具配置中提供 `accessToken`。授权域映射在 `lib/tools/_shared/feishu-oauth.mjs`：`docs` 包含 `docx:document:readonly`、`space:document:retrieve`，`media` 包含 `docs:document.media:download`，`wiki` 包含 `wiki:wiki:readonly`、`wiki:node:read`，`sheets` 包含 `sheets:spreadsheet:read`、`sheets:spreadsheet.meta:read`，`contact` 包含用户基础资料读取权限。
- `anthropic_server` 工具不会由 `runTool()` 执行；它们只会被传给 provider。
- `anthropic_server` 工具会被转换为 Anthropic 工具格式：`apiToolType/type` → `type`，`maxUses` → `max_uses`，`allowedDomains/blockedDomains` → `allowed_domains/blocked_domains`。
- `systemPrompt()` 不会随工具定义直接发送，而是在 `message-normalizer.mjs` 的 `buildSystemPrompt()` 中拼接进系统提示。
- `resolveDefinition()` 是可选的运行时定义改写钩子（详见上文「运行时定义改写」一节）；专家 agent catalog 注入现在由 `delegate_task` 自身的 `resolveDefinition` 完成，`registry.mjs` 不再硬编码工具名。改写产出需保持字节稳定以保前缀缓存。
- `registry.getToolRuntime(name)` 对禁用工具、未知工具、`anthropic_server` 工具都会返回不可本地执行的结果。
- `getEnabledToolDefinitions()` 会过滤 `adapter: 'unavailable'`，但会保留 `anthropic_server` 工具给模型使用。
- `handler` 的返回对象会被 `formatToolOutput()` JSON 字符串化后作为 Anthropic `tool_result.content` 发回模型。
- `parseResult` 的返回数据只用于 UI 渲染，不会替代发给模型的工具输出。
- 新增工具字段应保持 JSON 可序列化，避免运行记录或会话保存失败。
