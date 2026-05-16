# xwork API 对接文档

## 基础信息

| 项目 | 值 |
|---|---|
| Base URL | `http://{host}:3000/api/v1` |
| CORS | `*`（任意来源可访问） |
| Content-Type | `application/json`（SSE 除外） |
| 错误响应格式 | `{ "error": "描述信息" }` |
| 状态码 | 200 成功、400 参数错误、404 资源不存在 |

---

## REST 端点

### 1. 当前活跃的渠道和模型

#### GET `/active`

获取当前选中的渠道 ID 和模型名，同时返回渠道列表（API Key 已掩码）。

**响应** `200`
```json
{
  "activeChannelId": "07c69e72",
  "activeModel": "deepseek-v4-flash",
  "channels": [
    {
      "id": "07c69e72",
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKey": "••••3f613f",
      "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
      "maxTokens": 8192,
      "extraHeaders": {}
    }
  ]
}
```

#### POST `/active`

切换活跃渠道或模型。`channelId` 和 `model` 均为可选，传入则覆盖。

**请求体**
```json
{ "channelId": "07c69e72", "model": "deepseek-v4-pro" }
```

**响应** `200` — 格式同 GET（返回更新后的状态）。

---

### 2. 渠道管理 (Channels)

每次操作渠道涉及 API Key 时，响应中的 `apiKey` 字段均为掩码值（`••••` + 后 4 位）。

#### GET `/channels`

返回所有渠道列表。

**响应** `200`
```json
[
  {
    "id": "07c69e72",
    "name": "deepseek",
    "baseUrl": "https://api.deepseek.com/anthropic",
    "apiKey": "••••3f613f",
    "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
    "maxTokens": 8192,
    "extraHeaders": {}
  }
]
```

#### POST `/channels`

创建新渠道。首个创建的渠道自动设为活跃。

**请求体**
```json
{
  "name": "deepseek",
  "baseUrl": "https://api.deepseek.com/anthropic",
  "apiKey": "sk-xxxxxxxx",
  "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "maxTokens": 8192,
  "extraHeaders": {}
}
```

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `name` | 是 | — | 渠道显示名称 |
| `baseUrl` | 是 | — | Anthropic Messages API 兼容地址 |
| `apiKey` | 否 | `""` | API 密钥 |
| `models` | 否 | `[]` | 模型列表 |
| `maxTokens` | 否 | `8192` | 每次请求最大 token 数 |
| `extraHeaders` | 否 | `{}` | 附加请求头 |

**响应** `200` — 返回创建的渠道对象。

#### PUT `/channels/:id`

更新渠道。API Key 传入掩码值或空字符串时保留原值不更新。

**请求体** — 同 POST，所有字段可选。

**响应** `200` — 返回更新后的渠道对象。

#### DELETE `/channels/:id`

删除渠道。若删除的是当前活跃渠道，自动切换到剩余第一个渠道。

**响应** `200`
```json
{ "ok": true }
```

---

### 3. 工具管理 (Tools)

#### GET `/tools`

返回所有内置工具及其启用状态。

**响应** `200`
```json
[
  {
    "id": "web_search",
    "name": "web_search",
    "title": "Web Search",
    "description": "Search the web using the provider-native web_search tool...",
    "category": "web",
    "adapter": "anthropic_server",
    "version": "1.0.0",
    "dangerLevel": "low",
    "enabled": true,
    "timeoutMs": 0,
    "maxUses": 8,
    "type": "web_search_20250305",
    "inputSchema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"]
    }
  }
]
```

#### PUT `/tools/:id`

更新工具配置。

**请求体**
```json
{ "enabled": false }
```

#### POST `/tools/:id/enable`

启用工具（等同于 `PUT { enabled: true }`）。

#### POST `/tools/:id/disable`

禁用工具（等同于 `PUT { enabled: false }`）。

---

### 4. 工具执行记录 (Tool Runs)

#### GET `/tool-runs?limit=20`

返回最近的工具执行记录。

**响应** `200`
```json
[
  {
    "runId": "uuid",
    "toolCallId": "toolu_xxx",
    "name": "web_search",
    "isError": false,
    "input": { "query": "..." },
    "output": { "sources": [...], "resultCount": 3 },
    "durationMs": 1234,
    "context": { "conversationId": "...", "channelId": "...", "model": "...", "adapter": "web_search" },
    "createdAt": "2026-05-14T10:30:00.000Z"
  }
]
```

---

### 5. 对话管理 (Conversations)

#### GET `/conversations`

返回所有对话摘要列表。

**响应** `200`
```json
[
  {
    "id": "uuid",
    "title": "今天天气怎么样？",
    "createdAt": "2026-05-14T10:00:00.000Z",
    "updatedAt": "2026-05-14T10:05:00.000Z",
    "messageCount": 4
  }
]
```

#### POST `/conversations`

创建新对话。

**请求体**
```json
{ "title": "New Chat" }
```

**响应** `200` — 返回完整对话对象（含空 `messages` 数组）。

#### GET `/conversations/:id`

获取单个对话详情（含完整消息历史）。

**响应** `200`
```json
{
  "id": "uuid",
  "title": "今天天气怎么样？",
  "createdAt": "...",
  "updatedAt": "...",
  "messages": [
    { "role": "user", "content": "今天天气怎么样？" },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "今天多云..." },
        { "type": "web_search_tool_result", "content": [...] }
      ],
      "model": "deepseek-v4-flash",
      "blocks": [
        { "type": "text", "content": "今天多云..." },
        { "type": "sources", "sources": [...], "searchCount": 1 }
      ],
      "sources": [...],
      "searchCount": 1
    }
  ]
}
```

消息结构说明：
- **`content`** — Anthropic Messages API 原始格式（`text` / `tool_use` / `tool_result` 等块）
- **`sources`** — 从所有工具结果中提取的来源聚合数组
- **`blocks`** — 前端渲染优化字段（text 和 sources 的有序排列），包含：
  - `{ "type": "text", "content": "..." }` — 文本段落
  - `{ "type": "sources", "sources": [...], "searchCount": N }` — 来源卡片

参见 [消息渲染](#消息渲染) 小节。

#### DELETE `/conversations/:id`

删除对话。

**响应** `200`
```json
{ "ok": true }
```

---

### 6. 聊天 (Chat) — SSE 流

#### POST `/chat`

发起聊天请求，返回 SSE 流。

**请求体**
```json
{
  "message": "查一下特朗普近况",
  "conversationId": "uuid",
  "channelId": "07c69e72",
  "model": "deepseek-v4-pro"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `message` | 是 | 用户输入内容 |
| `conversationId` | 否 | 对话 ID，不传则仅此轮无历史 |
| `channelId` | 否 | 指定渠道，不传则用当前活跃渠道 |
| `model` | 否 | 指定模型，不传则用当前活跃模型 |

**响应头**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

---

## SSE 事件规范

流中每个事件格式为 `data: <JSON>\n\n`。解析方式：

```js
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6);
    if (raw === '[DONE]') return;            // 流结束
    const evt = JSON.parse(raw);
    switch (evt.type) {
      case 'delta':       /* ... */ break;
      case 'thinking':    /* ... */ break;
      case 'tool_call':   /* ... */ break;
      case 'tool_result': /* ... */ break;
      case 'done':        /* ... */ break;
      case 'error':       /* ... */ break;
    }
  }
}
```

### `delta` — 文本增量

助手回复的增量文本。

```json
{
  "type": "delta",
  "text": "好的，我来帮你查一下。"
}
```

前端应将该文本追加到当前渲染的助手消息尾部。

### `thinking` — 思考过程

模型的内部推理文本（若模型支持）。

```json
{
  "type": "thinking",
  "text": "用户想查特朗普近况，我需要先搜索，再整理结果..."
}
```

前端可以弹窗或折叠区域展示此内容（当前 xwork 前端用右上角浮窗显示）。

### `tool_call` — 工具调用开始

助手决定调用一个或多个工具。

```json
{
  "type": "tool_call",
  "tools": [
    {
      "id": "toolu_01ABC123...",
      "name": "web_search",
      "input": { "query": "特朗普 2026 最新动态" }
    }
  ]
}
```

`tools` 为数组，一次可能包含多个工具调用。前端可以展示"正在搜索..."之类状态指示。

### `tool_result` — 工具执行结果

工具执行完毕后返回。**关键：根据 `renderType` 决定渲染方式。**

```json
{
  "type": "tool_result",
  "tools": [
    {
      "id": "toolu_01ABC123...",
      "name": "web_search",
      "isError": false,
      "durationMs": 1234,
      "input": { "query": "特朗普 2026 最新动态" },
      "renderType": "source-cards",
      "data": {
        "sources": [
          {
            "title": "特朗普宣布参加2028大选",
            "url": "https://example.com/news/1",
            "pageAge": "2 hours ago",
            "snippet": "特朗普在佛罗里达发表演讲..."
          }
        ],
        "resultCount": 1
      }
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 与 `tool_call` 中的 id 对应 |
| `name` | 工具名 |
| `isError` | 是否执行失败 |
| `durationMs` | 工具执行耗时（毫秒） |
| `input` | 工具调用时的输入参数 |
| `renderType` | 渲染类型，决定前端如何展示此结果 |
| `data` | 渲染数据，结构由 `renderType` 决定 |

#### `renderType` 枚举

| renderType | 含义 | data 结构 | 前端渲染方式 |
|---|---|---|---|
| `"source-cards"` | 搜索结果 | `{ sources: [...], resultCount: N }` | 渲染为可折叠的来源卡片列表 |
| 其他 / 无 | 通用结果 | 任意 | 不产生可见 UI，或按工具自定义处理 |

#### Source 对象结构

```json
{
  "title": "文章标题",
  "url": "https://...",
  "pageAge": "2 hours ago",
  "snippet": "内容摘要片段"
}
```

### `done` — 流正常结束

```json
{
  "type": "done",
  "stopReason": "end_turn",
  "usage": { "input_tokens": 150, "output_tokens": 320 }
}
```

### `error` — 错误

```json
{
  "type": "error",
  "message": "API error 429"
}
```

收到 `error` 后流将关闭，无需等待 `done`。

### 流结束信号

`done` 事件之后会发一行 `data: [DONE]\n\n` 再关闭连接（对 fetcher 而言流自动结束即可，无需特殊处理）。

---

## 消息渲染

从 `/api/v1/conversations/:id` 加载历史对话时，assistant 消息包含 `blocks` 数组用于渲染。其结构与 SSE 流中的事件语义对应：

```
SSE 流                       消息存储 (blocks)
───────                      ─────────────────
delta                ──→     { type: 'text', content: '...' }
tool_result          ──→     { type: 'sources', sources: [...], searchCount: N }
(sources 之后自动起新文本块) ──→  { type: 'text', content: '' }
```

`blocks` 是 `text` 和 `sources` 的有序序列，按原始出现顺序排列。渲染时遍历 blocks，`text` 块走 Markdown 渲染，`sources` 块渲染为来源卡片。

---

## 数据流全景

```
用户输入 "查一下特朗普近况"
        │
        ▼
POST /api/v1/chat ──────────────────────────────────────────┐
        │                                                    │
        ▼ (SSE)                                              │
  data: {"type":"delta","text":"好的，我来搜索..."}            │
  data: {"type":"tool_call","tools":[{...web_search...}]}     │  ← 服务端自动
  data: {"type":"tool_result","renderType":"source-cards",..} │    多轮工具循环
  data: {"type":"delta","text":"根据搜索结果..."}              │
  data: {"type":"done","stopReason":"end_turn"}              │
  data: [DONE]                                               │
        │                                                    │
        ▼                                                    │
  对话已自动持久化 ←──────────────────────────────────────────┘
        │
        ▼
GET /api/v1/conversations/:id  →  返回含 blocks 的完整消息
```
