# Tool 开发指南

## 目录结构

```
lib/tools/
├── builtin/           ← 内置工具定义
│   ├── index.mjs      ← 导出 builtinTools 数组
│   ├── calculator.mjs
│   ├── current-time.mjs
│   ├── uuid-gen.mjs
│   └── web-search.mjs
├── runner.mjs         ← 工具执行引擎（生命周期 + parseResult）
├── registry.mjs       ← 工具注册 + 启用/禁用 + 配置
├── runs.mjs           ← 工具运行记录（写入 data/tool-runs.json）
└── store.mjs          ← 工具配置持久化（读写 data/tools.json）

data/
├── tools.json         ← 工具配置：enabled / timeoutMs / config
└── tool-runs.json     ← 最近 200 条运行记录
```

---

## 定义一个工具

最小工具定义：

```js
// lib/tools/builtin/my-tool.mjs
export const myTool = {
  id: 'my_tool',                  // 唯一标识
  name: 'my_tool',                // 给 AI 的函数名
  title: 'My Tool',               // 前端展示名
  description: 'What this tool does.',
  category: 'system',             // system / web / ...
  adapter: 'builtin',             // builtin | anthropic_server
  version: '1.0.0',
  dangerLevel: 'low',             // low / medium / high
  defaultEnabled: true,
  timeoutMs: 5000,
  inputSchema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: '...' },
    },
    required: ['param1'],
    additionalProperties: false,
  },

  async handler(input, { config, context }) {
    // 核心逻辑
    return { result: '...' };
  },
};
```

注册到 `lib/tools/builtin/index.mjs`：

```js
import { myTool } from './my-tool.mjs';
export const builtinTools = [..., myTool];
```

---

## 适配器类型

### `adapter: 'builtin'`

由 `runner.mjs` 本地执行。提供完整的生命周期钩子。

### `adapter: 'anthropic_server'`

由 API 提供商（Anthropic）执行。额外字段：

```js
{
  adapter: 'anthropic_server',
  apiToolType: 'web_search_20250305',  // Anthropic 原生工具类型
  maxUses: 8,                           // 每轮最大调用次数
  systemPrompt: () => '策略提示词...',    // 注入模型的额外提示
  parseStreamResult(block) {            // 解析 SSE 流结果
    return { renderType: 'source-cards', data: { sources, resultCount } };
  },
}
```

---

## 生命周期钩子

执行顺序：`validate → before → handler → after → parseResult`

错误路径：任何阶段抛错 → `onError → onComplete`

`onComplete` 始终触发（fire-and-forget，不阻塞）。

### validate

```js
validate(input, { config, context }) {
  if (!input.query) throw new Error('query is required');
}
```

throw 即拒绝本次调用。

### before

```js
async before(input, { config, context }) {
  // 可修改 input（返回值会成为 handler 的 input）
  return { ...input, precision: config.precision ?? 12 };
}
```

返回 `{ skipHandler: true, result }` 可跳过 handler 直接产出结果。

### handler

```js
async handler(input, { config, context }) {
  const result = doWork(input);
  return { input: input.param, result };
}
```

`runner.mjs` 对 handler 施加 `Promise.race(timeoutMs)` 超时保护。

### after

```js
after(input, output, { config, context }) {
  // 转换 handler 输出
  if (output && typeof output.result === 'number') {
    output.result = parseFloat(output.result.toPrecision(12));
  }
  return output;
}
```

默认行为：原样返回 `output`。

### onError

```js
async onError(err, input, { config, context }) {
  // 可返回 fallback 值（标记为成功），或 re-throw（标记为失败）
  if (err.message.includes('timeout')) {
    return { fallback: true, message: 'Service unavailable' };
  }
  throw err;
}
```

### onComplete

```js
onComplete(outcome, durationMs) {
  console.log(`[my_tool] ${outcome.isError ? '✗' : '✓'} (${durationMs}ms)`);
}
```

`outcome` 结构：`{ id, name, isError, input, output, durationMs, error? }`。

---

## 配置

工具配置存储在 `data/tools.json`，可通过 API 动态修改：

```js
// data/tools.json 中的条目
{
  "id": "my_tool",
  "enabled": true,
  "timeoutMs": 5000,
  "config": { "precision": 12 },   // 任意自定义配置，传入钩子的 hookCtx.config
  "updatedAt": "2026-05-15T..."
}
```

在钩子中通过 `{ config }` 访问：

```js
async handler(input, { config }) {
  const precision = config.precision ?? 12;
  // ...
}
```

---

## 结果渲染

数据流：

```
handler output → parseResult(output, input) → result.render
  → query-loop SSE → { type:'tool_result', renderType, data }
  → app.js tool_result handler → blocks.push({ type, ...data })
  → app.js renderBlocks() → 对应渲染函数
  → style.css
```

### 后端：加 parseResult

```js
parseResult(output, input) {
  return {
    renderType: 'my-render-type',   // 前端按此类型选择组件
    data: {
      // 渲染所需数据，会完整透传到前端 block
      items: output.items,
      total: output.total,
    },
  };
}
```

### 前端：三处改动（app.js）

**1. SSE 事件处理**（`tool_result` 分支，约 890 行）：

```js
if (tool.renderType === 'my-render-type' && tool.data) {
  blocks.push({ type: 'my-render-type', ...tool.data });
}
```

**2. renderBlocks 分支**（约 600 行）：

```js
if (block.type === 'my-render-type') {
  return renderMyBlock(block.items, block.total);
}
```

**3. 渲染函数**：

```js
function renderMyBlock(items, total) {
  return `
    <div class="my-block-container">
      ${items.map(item => `<div class="my-item">${escHtml(item)}</div>`).join('')}
    </div>
  `;
}
```

### 前端：加 CSS（style.css）

按渲染函数产出的 DOM 结构写样式，复用项目 CSS 变量（`--accent`、`--border`、`--bg-secondary` 等）。

### 现有渲染类型

| renderType | 工具 | 说明 |
|---|---|---|
| `source-cards` | web_search | 可折叠来源卡片列表 |
| `uuid-list` | uuid_gen | UUID 列表 + 逐行/全部复制 |

---

## 工具配置 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/tools` | 列出所有工具及其配置 |
| PUT | `/api/v1/tools/:id` | 更新 enabled / timeoutMs / config |
| GET | `/api/v1/tool-runs?limit=N` | 最近 N 条运行记录 |

---

## 新建工具 Checklist

1. 创建 `lib/tools/builtin/<name>.mjs`，定义工具对象
2. 在 `lib/tools/builtin/index.mjs` 中 import 并加入 `builtinTools` 数组
3. 如需渲染：实现 `parseResult`
4. 如需渲染：在 `public/app.js` 的 `tool_result` 处理、`renderBlocks` 加分支，添加渲染函数
5. 如需渲染：在 `public/style.css` 加样式
6. 重启服务，工具自动注册到 `data/tools.json`
