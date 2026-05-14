# xwork

自托管 AI 聊天服务，兼容 Anthropic Messages API 协议。支持多渠道/模型配置、自动工具调用循环、SSE 流式响应。

## 快速启动

```bash
npm start        # 生产启动 (端口 3000)
npm run dev      # 开发模式 (文件变更自动重启)
```

打开 `http://localhost:3000` 使用 Web 聊天界面。

## 渠道配置

编辑 `config.json` 添加模型渠道：

```json
{
  "channels": [
    {
      "id": "xxx",
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKey": "sk-xxx",
      "models": ["deepseek-v4-flash"],
      "maxTokens": 8192,
      "extraHeaders": {}
    }
  ],
  "activeChannelId": "xxx",
  "activeModel": "deepseek-v4-flash"
}
```

## API 文档

详见 [API.md](./API.md)。

---

# 自定义工具

## 工具定义接口

在 `lib/tools/builtin/` 下创建 `.mjs` 文件，导出工具对象：

```js
export const myTool = {
  // ========== 必填 ==========
  id: 'my_tool',                    // 唯一标识
  name: 'my_tool',                  // 传给模型的名字
  title: 'My Tool',                 // 前端展示名
  description: '描述给模型看的工具用途',
  category: 'system',               // 分类: web | system
  adapter: 'builtin',               // builtin=本地执行, anthropic_server=API 服务端执行
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 5000,
  inputSchema: {                    // JSON Schema，模型按此填参数
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '关键词' },
    },
    required: ['keyword'],
  },

  // ========== 核心执行 ==========
  async handler(input, { config, context }) {
    // input   = 模型传入的参数（符合 inputSchema）
    // config  = 用户通过 API 保存的自定义配置
    // context = { conversationId, channelId, model }
    return { result: `查询: ${input.keyword}` };
  },
};
```

然后在 `lib/tools/builtin/index.mjs` 注册：

```js
import { myTool } from './my-tool.mjs';
export const builtinTools = [..., myTool];
```

## 生命周期钩子

所有钩子均为可选。执行顺序：

```
validate → before → handler → after → onComplete
         ↘ 任一步抛错 → onError → onComplete
```

### `validate(input, { config, context })`

参数校验。抛错拒绝调用，不进 onError 则走默认错误处理。

```js
validate({ keyword }) {
  if (!keyword || keyword.length > 200) {
    throw new Error('keyword 必填且不超过 200 字符');
  }
}
```

### `before(input, { config, context })`

预处理钩子。三种返回值行为：

| 返回值 | 效果 |
|---|---|
| `undefined` | 原 input 直接传给 handler |
| 普通对象 | 替换 handler 的 input 参数 |
| `{ skipHandler: true, result }` | 跳过 handler 执行，result 作为最终输出 |

```js
async before(input, { config }) {
  const cached = await cache.get(input.keyword);
  if (cached) return { skipHandler: true, result: cached };
  return { ...input, limit: input.limit ?? 10 };  // 注入默认值
}
```

### `after(handlerInput, output, { config, context })`

结果后处理。`handlerInput` 是经过 `before` 转换后的参数。返回值替换 `output`。

```js
after(input, output) {
  return { ...output, processedAt: new Date().toISOString() };
}
```

### `onError(err, input, { config, context })`

错误恢复。返回 fallback 结果则 `isError=false`，抛错 / 不实现则走默认错误处理（`isError=true`）。

```js
onError(err, input) {
  if (err.message.includes('timeout')) {
    return { fallback: '查询超时，请稍后重试' };
  }
  throw err;  // 恢复不了，继续抛
}
```

### `onComplete(outcome, durationMs)`

fire-and-forget，用于日志/监控。始终执行（无论成功失败）。返回值被忽略。

```js
onComplete(outcome, durationMs) {
  console.log(`[my_tool] ${outcome.isError ? '✗' : '✓'} ${durationMs}ms`);
}
```

`outcome` 结构：`{ id, name, isError, input, output, durationMs, error? }`

## 渲染拓展: `parseResult`

控制 builtin 工具结果在前端的渲染方式。不定义则前端只展示"成功/失败 + 耗时"。

```js
parseResult(output, input) {
  return {
    renderType: 'source-cards',    // 前端按类型选择渲染组件
    data: {
      sources: [
        { title: '结果1', url: 'https://...', pageAge: '1h ago', snippet: '摘要...' },
      ],
      resultCount: 1,
    },
  };
}
```

与 anthropic_server 工具的 `parseStreamResult` 产出同一结构 `{ renderType, data }`，前端渲染协议统一。`renderType` 目前支持：

| renderType | data 结构 | 前端渲染 |
|---|---|---|
| `source-cards` | `{ sources: [...], resultCount: N }` | 来源卡片列表 |

## anthropic_server 工具

`adapter: 'anthropic_server'` 的工具由 API 提供商执行（如 Anthropic 原生 web_search）。额外可用字段：

```js
{
  adapter: 'anthropic_server',
  apiToolType: 'web_search_20250305',   // Anthropic 原生工具类型
  maxUses: 5,                           // 每轮最大调用次数
  systemPrompt: () => '策略提示词...',    // 注入模型的额外提示
  parseStreamResult(block) {            // 解析 SSE 流中的结果块
    if (block.type !== 'web_search_tool_result') return null;
    return { renderType: 'source-cards', data: { sources: [...], resultCount: N } };
  },
}
```

## 用户自定义配置

工具运行时可通过 API 动态修改配置，无需改代码：

```bash
curl -X PUT http://localhost:3000/api/v1/tools/my_tool \
  -H 'Content-Type: application/json' \
  -d '{"config": {"apiKey": "xxx", "limit": 20}}'
```

handler 及其他钩子的 `config` 参数即为这个对象。
