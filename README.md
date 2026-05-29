# xwork

自托管 AI 聊天服务，兼容 Anthropic Messages API 协议。支持多渠道/模型配置、自动工具调用循环、SSE 流式响应。

## 快速启动

```bash
npm start        # 生产启动 (端口 3000)
npm run dev      # 开发模式 (文件变更自动重启)
```

打开 `http://localhost:3000` 使用 Web 聊天界面。

## 默认渠道配置

首次启动时会自动初始化 DeepSeek 渠道和 MiniMax Token Plan VLM 图片识别 provider。默认 API key 为空，只需要在 Channels 页面分别填入 DeepSeek API Key 和 MiniMax API Key 即可使用。

```json
{
  "channels": [
    {
      "id": "911c406a",
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiKey": "",
      "models": [
        {
          "id": "deepseek-v4-flash",
          "capabilities": { "imageInput": false },
          "unsupportedImagePolicy": {
            "action": "vision_to_text",
            "onVisionFailure": "reject"
          }
        }
      ],
      "maxTokens": 8192,
      "maxTurns": 100,
      "extraHeaders": {}
    }
  ],
  "activeChannelId": "911c406a",
  "activeModel": "deepseek-v4-flash",
  "visionProviders": [
    {
      "id": "minimax-token-plan-vlm",
      "name": "MiniMax Token Plan VLM",
      "adapter": "http_json",
      "enabled": true,
      "config": {
        "url": "https://api.minimaxi.com/v1/coding_plan/vlm",
        "method": "POST",
        "timeoutMs": 90000,
        "headers": { "MM-API-Source": "Minimax-MCP" },
        "auth": { "type": "bearer", "apiKey": "" },
        "request": {
          "bodyTemplate": {},
          "promptPath": "prompt",
          "imagePath": "image_url",
          "imageFormat": "data_url"
        },
        "response": {
          "textPath": "content",
          "successPath": "base_resp.status_code",
          "successValue": 0,
          "errorCodePath": "base_resp.status_code",
          "errorMessagePath": "base_resp.status_msg",
          "traceHeader": "trace-id"
        }
      }
    }
  ],
  "vision": {
    "defaultChannelId": null,
    "defaultModelId": null,
    "defaultProviderId": "minimax-token-plan-vlm",
    "defaultFailureAction": "ask_user"
  }
}
```

`models` 使用对象配置。`capabilities.imageInput=true` 表示模型可直接接收图片；不支持图片时，`unsupportedImagePolicy.action` 可选 `vision_to_text`、`ask_user`、`reject`。`vision_to_text` 会使用模型级 `unsupportedImagePolicy.visionProviderId` 或全局 `vision.defaultProviderId` 对应的 `visionProviders` 先生成图片摘要/OCR，再交给当前文本模型。

视觉 provider 当前 adapter 支持：

- `anthropic_model`：复用一个支持原生图片输入的 Anthropic Messages 兼容渠道/模型。
- `http_json`：调用任意返回 JSON 的第三方图片解析接口，通过 `request.*` 配置 prompt/图片写入位置，通过 `response.*` 配置识别文本、成功码、错误码和 trace header 的读取位置。MiniMax Token Plan VLM 是这个 adapter 的一个配置示例，不需要专属调用代码。

识别失败处理可配：模型级 `unsupportedImagePolicy.onVisionFailure` 优先，其次使用全局 `vision.defaultFailureAction`。可选值为 `reject`、`remove_images`、`ask_user`。

## API 文档

详见 [API.md](./API.md)。
工具开发详见 [TOOL.md](./TOOL.md)。

## 飞书文档 / 表格工具

内置 `feishu_read` 工具可读取飞书新版文档、旧版文档、知识库文档和电子表格范围数据。`feishu_auth` 工具负责飞书应用凭据和当前用户授权，行为参考 `lark-cli auth login` 的 Device Flow：启动授权、弹出飞书授权页、轮询等待用户同意，然后保存 `user_access_token`。这两个工具默认关闭；在 Tools 页面启用二者，并在 `Feishu Auth` 的 Parameters 填写 `app_id` / `app_secret` 后保存。

也可以用环境变量配置飞书自建应用凭据：

```powershell
$env:FEISHU_APP_ID="cli_xxx"
$env:FEISHU_APP_SECRET="xxx"
npm start
```

也可以通过环境变量提供 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。`feishu_auth` 负责保存 `user_access_token`；`feishu_read` 只配置读取范围、输出大小等读取行为参数。未授权或 token 已失效时，`feishu_read` 会自动委托同一套 `feishu_auth` Device Flow，前端弹出授权子页面，用户同意后工具继续执行。读取文档、知识库、表格或文档图片/附件遇到租户权限不足时，也会按资源类型追加读权限 scope 并用用户 token 重试。

飞书授权 scope 按工具动作自动追加：

- `read_doc` / `get_doc_blocks` / `read_doc_rich`：需要 `docx:document:readonly`、`space:document:retrieve`
- `read_wiki`：需要 `wiki:wiki:readonly`、`wiki:node:read`，并会按实际节点类型追加文档或表格读取权限
- `read_sheet` / `get_sheet_meta`：需要 `sheets:spreadsheet:read`、`sheets:spreadsheet.meta:read`
- `download_media`：需要文档读取权限以及 `docs:document.media:download`
- `get_user`：需要 `contact:user.base:readonly`、`contact:user.basic_profile:readonly`

启用后模型可用飞书 URL 或 token 调用：

```json
{ "action": "login" }
{ "action": "start" }
{ "action": "complete", "deviceCode": "xxx" }
{ "action": "read_doc", "url": "https://xxx.feishu.cn/docx/..." }
{ "action": "get_doc_blocks", "url": "https://xxx.feishu.cn/docx/..." }
{ "action": "read_doc_rich", "url": "https://xxx.feishu.cn/docx/..." }
{ "action": "download_media", "fileToken": "boxcn..." }
{ "action": "read_wiki", "url": "https://xxx.feishu.cn/wiki/..." }
{ "action": "read_sheet", "url": "https://xxx.feishu.cn/sheets/...", "ranges": ["sheetId!A1:D20"] }
{ "action": "get_current_user" }
{ "action": "get_user", "userId": "ou_xxx", "userIdType": "open_id" }
```

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
| `web-fetch` | `{ url, statusCode, contentType, contentLength, cached, contentPreview }` | 网页内容卡片 |
| `browser-action` | `{ action, url, title, statusCode, text?, result?, screenshotPath? }` | 浏览器动作摘要 |
| `shell-command` | `{ command, cwd, exitCode, stdout, stderr, durationMs, truncated }` | 终端样式输出 |

## anthropic_server 工具

`adapter: 'anthropic_server'` 的工具由 API 提供商执行（如 Anthropic 原生 web_search）。额外可用字段：

```js
{
  adapter: 'anthropic_server',
  apiToolType: 'web_search_20250305',   // Anthropic 原生工具类型
  maxUses: 4,                           // 每轮最大调用次数
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
