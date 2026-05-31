# xwork 工具插件设计方案:对标 Claude Code 的 28 个新工具

## Context（为什么做这件事）

宁筠希望对比 Claude Code 的工具体系，为 xwork 设计一批新工具插件，补齐 xwork 作为通用 AI agent 服务的能力短板。

xwork 现有 19 个工具，已覆盖：文件读写/搜索/大纲、git 只读、shell、web 搜索/抓取、Playwright 浏览器、飞书只读、子代理委派、人机交互。但对比 Claude Code 与通用 agent 体系，明显缺失：**任务清单管理、持久化记忆、定时任务、多文件 patch 编辑、后台进程管理、notebook 编辑、计划确认**等通用 agent 能力，以及**通用 HTTP 调用、数据库查询、结构化数据处理、压缩/编码**等集成扩展能力，还有**飞书写入、消息通知、会话检索、用量分析、渠道健康、专家 agent 管理**等贴合 xwork 自身的场景能力。

本方案产出 **28 个工具的完整设计蓝图**（设计骨架 + 思路 + 基础设施复用 + 风险，不含可运行实现代码，遵守"写代码前不写代码"约定），覆盖三个方向：A 对标 Claude Code 缺失项、B 通用集成扩展、C 贴合 xwork 场景。本文件是后续开发的蓝图，不是实现。

### 已确认的关键决策（来自宁筠）

1. **保留全部 28 个工具**，三方向全覆盖，四个高危/框架级项（cron、bg_shell、feishu_write、team_message）全部纳入。
2. **task 系列合并为 1 个多 action 工具**（`task`，action: create/list/update/get/delete），对标 git/feishu_read 的多 action 风格，腾出名额。
3. **不做图像理解**：原 understand_image 移除，替换为 notebook_edit。
4. **策略由用户配置、不预设强制安全限制**：vision/host/扩展名/密钥白名单等不在工具里硬编码门禁，统一通过 configSchema 暴露给用户配置，默认宽松；仅保留功能性的路径越界校验与大小上限（稳定性，非安全门禁）。
5. **feishu_write 写权限授权流程确认要做**。

---

## 必须遵守的工具系统契约（实现时基准）

每个工具是 `lib/tools/<slug>/index.mjs` 导出 `export const tool = {...}`：

- **身份**：`id` / `name` / `title` / `description` / `category` / `adapter`('builtin'|'anthropic_server') / `version` / `dangerLevel`('low'|'medium'|'high') / `defaultEnabled`
- **配置**：`timeoutMs` / `defaultConfig` / `configSchema` / `maxUses`
- **API 定义**：`inputSchema`(JSON Schema) / `capabilities.executionMode`('sequential'|'parallel_batch')
- **builtin 生命周期钩子**：`validate → before → handler(input,{config,context,signal,emit}) → after → modelOutput → parseResult → onComplete`；错误走 `onError`。handler 返回对象会被 JSON 字符串化发给模型。
- **handler 的 context**：`source/environment/conversationId/channelId/model/agentRunId/rootRunId/parentRunId/agentDepth/expertAgentId/toolCallId`
- **动态定义（可选）**：`runtimeContext:string[]` + `resolveDefinition(definition,runtimeContext)`，**改写产物须字节稳定**以命中上游前缀缓存
- **前端渲染**：`parseResult(output)` 返回 `{renderType, data}`，配合 `ui.mjs` 的 `renderBlock`；长耗时工具可 `emit({stream,text})` 流式 + `stream.mjs`；可选 `client.mjs`/`assets.mjs`/`styles.css`

---

## 必须复用的现有基础设施（禁止重造）

| 基础设施 | 文件 | 用途 |
|---|---|---|
| 工作区根 | `lib/workspace-root.mjs` | `getWorkspaceRoot()` / `getProjectRoot()` / `isInsideWorkspace(absPath)` / `getWorkspaceInfo()` |
| 文件安全 | `lib/workspace-files.mjs` | `resolveWorkspaceFilePath()` / `resolveWorkspaceDirectoryPath()` / `getPathPolicyFailure()` / `readWorkspaceTextFile()` / `DEFAULT_BLOCKED_GLOBS` / `BLOCKED_EXTENSIONS` / `isBlockedEnvFile()` / `isSecretBasename()` —— **所有文件类工具必须经此做路径越界校验** |
| 文档存储 | `lib/sqlite-store.mjs` | `createSqliteDocumentStore({key,defaultValue,normalize,serialize})` → `{read,write,update}`；`listConversationDocuments()` / `getConversationDocument(id)` |
| 阻塞交互 | `lib/tools/ask-user/index.mjs` | `userInputRegistry.waitForAnswer()`，`agentDepth>0` 时禁止 —— plan_confirm 直接复用 |
| 子代理 | `lib/agents/subagent-runtime.mjs` / `lib/agents/profiles.mjs` | `runSubagent()` / `listExpertAgents()` 等（key=`expert-agents`） |
| 用量 | `lib/usage-report.mjs` | `buildUsageReport({limit,includeTest})` |
| 飞书 | `lib/tools/_shared/feishu-oauth.mjs` | token 获取 / scope 映射 |
| 探索 prompt | `lib/tools/_shared/workspace-exploration-prompt.mjs` | 探索类工具共享 systemPrompt |
| 字节稳定改写 | `lib/tools/delegate-task/index.mjs` | `resolveDefinition` 范式 |

---

## 一、需要先建的共享基础设施（地基）

| 新增项 | 类型 | 用途 | 被依赖工具 |
|---|---|---|---|
| `lib/tools/_shared/doc-store-helpers.mjs` | _shared 模块 | 基于 `createSqliteDocumentStore` 的集合类文档通用 CRUD（list/get/create/update/delete + id 生成 + 上限裁剪 + updatedAt） | task / memory / cron / notify / team_message |
| `lib/tools/_shared/structured-data.mjs` | _shared 模块 | JSON/YAML/CSV/TOML 解析序列化 + 路径取值，纯函数 | data_transform / csv_inspect / yaml_toml / jq_query |
| `lib/tools/_shared/http-client.mjs` | _shared 模块 | 受控 fetch：超时 / 跨域重定向不跟随 / 响应大小上限 / 可选 host 策略（默认放开） | http_request / file_download / notify / channel_health |
| `lib/tools/_shared/background-tasks.mjs` | _shared 模块 | 后台进程注册表（spawn/list/output 环形缓冲/kill），进程挂在 server 进程上，signal 联动 | bg_shell / bg_output / bg_stop |
| `lib/tools/_shared/shell-safety.mjs` | _shared 模块 | 从 shell_command 抽出的命令黑名单/cwd 校验，供 bg_shell 复用 | bg_shell |
| `lib/cron-runner.mjs`（**框架级**，非工具） | server 服务 | 常驻定时器，idle 时把到期 cron 任务的 prompt 投进对应 conversation 的 run | cron_create / cron_manage |
| SQLite document key | 存储 | 新增 `tool-tasks` / `tool-memory` / `tool-cron` / `tool-notify` / `tool-secrets` / `tool-team-messages` | 对应工具 |
| 新 category | 常量 | `productivity`（task/memory/cron/plan）、`data`（结构化数据/编码/diff/db）、`integration`（http/通知/下载/压缩） | 对应工具 |
| 新 renderType | UI | `task-list` / `memory-list` / `cron-list` / `http-response` / `data-table` / `diff-view` / `notebook-edit` / `background-task` / `db-result` / `notify-result` / `usage-report` / `channel-health` / `conversation-results` / `expert-agent-list` / `archive-result` / `plan-confirm` / `team-message` | 对应工具 ui.mjs |
| runtime-context loader `cronJobs` | registry 扩展 | cron_create 可选把现有 jobs 注入 description（字节稳定） | cron_create |

---

## 二、28 个工具完整设计

### 方向 A：对标 Claude Code 缺失项（10 个工具）

#### A1 — `task`（任务清单，多 action）
- **对标**：TaskCreate/TaskList/TaskUpdate/TaskGet（合并为 1 个）。category `productivity` / builtin / **low** / 默认启用。timeoutMs 5000。
- **inputSchema**：`action`(enum create/list/update/get/delete，必填) + 各 action 专属：create 用 `subject`(必填)/`description`/`activeForm`/`blockedBy[]`/`owner`/`metadata`；list 用 `status`/`owner`/`conversationId`/`limit`；update 用 `taskId`(必填)/`status`/`addBlockedBy`/`addBlocks`/`metadata`；get/delete 用 `taskId`(必填)。
- **handler**：复用 `doc-store-helpers` 操作 key=`tool-tasks`，生成短 id、`status:'pending'`、`createdAt`；维护双向 blocks/blockedBy 一致性 + 循环依赖 DFS 检测；清单上限裁剪（如 500）。纯 SQLite 无文件 IO。
- **UI/持久化**：ui.mjs renderType `task-list`；key `tool-tasks`。
- **风险/决策**：作用域默认全局 + `metadata.conversationId` 软隔离。是否自动注入 system prompt（提醒未完成 todo）= 框架改动，P1 再做。

#### A2 — `memory`（持久化记忆）
- **对标**：Memory。`productivity` / builtin / **medium** / **默认禁用**。timeoutMs 5000。
- **inputSchema**：`action`(write/read/list/delete，必填) / `key`(write/read/delete 必填) / `value`(write 必填) / `category` / `scope`(global/conversation)。
- **handler**：key=`tool-memory`，经 doc-store-helpers；scope=conversation 时 key 前缀 conversationId；value 大小上限 32KB；纯 SQLite（区别于 CC 文件式 memory，更符合 xwork 架构）。
- **UI/持久化**：renderType `memory-list`；key `tool-memory`；client.mjs 设置页查看/清空。
- **风险/决策**：是否自动注入 system prompt = 框架改动（message-normalizer hook），P1；medium + 默认禁用 + 可清空。

#### A3 — `bg_shell`（启动后台进程）
- **对标**：run_in_background。`system` / builtin / **high** / **默认禁用**。timeoutMs 5000（仅启动不等待）。
- **inputSchema**：`command`(必填) / `cwd` / `label` / `env`(白名单)。
- **handler**：复用 `shell-safety.mjs`（从 shell_command 抽出的黑名单/cwd 校验）+ `background-tasks.mjs` spawn，注册进程表，stdout/stderr 进环形缓冲，立即返回 `{taskId,pid,command}`；最大并发后台进程数；进程随 server 退出清理。
- **UI**：renderType `background-task`；进程表内存态（pid 跨重启无意义）。
- **风险/决策**：进程逃逸/僵尸/server 重启孤儿进程；生产风险高。**已确认纳入**。

#### A4 — `bg_output`（读取后台输出）
- **对标**：TaskOutput。`system` / builtin / **low** / 默认禁用。timeoutMs 5000。
- **inputSchema**：`taskId`(必填) / `tail`(行数) / `stream`(stdout/stderr/both)。
- **handler**：从 `background-tasks.mjs` 读环形缓冲，返回尾部 + exitCode（若已退出）。
- **UI**：复用 `background-task` / `shell-command`。

#### A5 — `bg_stop`（停止后台进程）
- **对标**：TaskStop/KillShell。`system` / builtin / **medium** / 默认禁用。timeoutMs 10000。
- **inputSchema**：`taskId`(必填) / `signal`(SIGTERM/SIGKILL)。
- **handler**：`background-tasks.mjs` kill，等待退出或超时升级 SIGKILL，清理进程表；只能 kill 自己启动的。

#### A6 — `cron_create`（定时/延时任务）
- **对标**：CronCreate。`productivity` / builtin / **high** / **默认禁用**。timeoutMs 5000。
- **inputSchema**：`cron`(5 字段表达式，必填) / `prompt`(必填) / `recurring`(默认 true) / `durable`(默认 false) / `label`。
- **handler**：写 key=`tool-cron`；实际触发由**新增 `lib/cron-runner.mjs`** 常驻服务在 idle 时执行，把 prompt 投进对应 conversation/channel/model 的 run；校验 cron 表达式；recurring 7 天过期（对标 CC）。
- **UI**：renderType `cron-list`；key `tool-cron`；可选 resolveDefinition 注入现有 jobs（需 cronJobs loader，字节稳定）。
- **风险/决策（重大）**：xwork 无常驻 idle 循环，需新增定时服务 + 定义"触发投到哪个 conversation/channel/model"。**已确认纳入**。

#### A7 — `cron_manage`（列出/删除定时任务）
- **对标**：CronList/CronDelete（合并）。`productivity` / builtin / **low**(list)~**medium**(delete) / 默认禁用。timeoutMs 5000。
- **inputSchema**：`action`(list/delete，必填) / `id`(delete 必填)。
- **handler**：读/删 key=`tool-cron`。
- **UI**：`cron-list`。

#### A8 — `apply_patch`（多文件统一 diff 编辑）
- **对标**：apply_patch/MultiEdit。`system` / builtin / **high** / **默认启用**。timeoutMs 15000。
- **inputSchema**：`patch`(自定义补丁格式或 unified diff，必填) / `dryRun`(bool)。
- **handler**：解析补丁 → 每个文件用 write_file 同款越界校验 + `getPathPolicyFailure` → 每个 hunk 在目标文件**唯一匹配**（复用 str_replace 唯一语义）→ **事务性**：全部校验通过才落盘，任一失败整体回滚（先全读后全写）；复用 `MAX_BYTES` / `invalidateWorkspaceFileIndex`。dryRun 只返回预期变更。
- **UI**：renderType `diff-view`（多文件 hunk 高亮）。
- **风险/决策**：补丁格式先支持"精确 context 匹配"子集（OpenAI 式 `*** Begin Patch`），失败要求模型回退 write_file。

#### A9 — `notebook_edit`（Jupyter Notebook 编辑）
- **对标**：NotebookEdit。`system` / builtin / **high** / **默认禁用**。timeoutMs 10000。
- **inputSchema**：`path`(.ipynb workspace 路径，必填) / `editMode`(enum replace/insert/delete，默认 replace) / `cellNumber`(number，0 索引) / `cellId` / `cellType`(code/markdown) / `newSource`(replace/insert 必填)。
- **handler**：resolveWorkspaceFilePath 读 .ipynb（JSON）→ 按 editMode 改 cells 数组（replace 整 cell source / insert 新 cell / delete cell）→ 校验 notebook JSON 结构合法 → write_file 同款路径校验落盘 + invalidateWorkspaceFileIndex。
- **UI**：renderType `notebook-edit`（cell 变更预览）。
- **说明**：补 xwork 完全缺失的 notebook 编辑能力（替换原图像理解名额）；策略（最大 cell 数等）由用户 configSchema 配置。

#### A10 — `plan_confirm`（计划确认 / ExitPlanMode）
- **对标**：ExitPlanMode。`agent` / builtin / **low** / **默认启用**。timeoutMs 600000。
- **inputSchema**：`plan`(markdown，必填) / `title` / `allowEdit`(bool)。
- **handler**：**完全复用 ask_user 的 userInputRegistry.waitForAnswer**，meta 用 `plan-approval` 形态；`before` 同样禁止 agentDepth>0；返回 approved/rejected/feedback。
- **UI**：renderType `plan-confirm`（渲染 markdown + 批准/否决/反馈按钮）；client.mjs 处理提交（类 ask-user 前端）。
- **风险/决策**：先做"展示+确认"，不做全局 plan-mode 状态锁（P1 可加）。

---

### 方向 B：通用集成与扩展（11 个工具）

#### B1 — `http_request`（通用 REST 调用）
- `integration` / builtin / **high** / **默认禁用**。timeoutMs 30000。
- **inputSchema**：`method`(enum GET/POST/PUT/PATCH/DELETE，必填) / `url`(必填) / `headers` / `body` / `json`(与 body 二选一) / `timeoutMs` / `maxResponseBytes`。
- **handler**：复用 http-client.mjs（超时、跨域重定向不跟随、响应大小上限、二进制只回 contentType+大小）；任意 host 默认放开（不强制门禁）。
- **UI**：renderType `http-response`。
- **策略（用户可配置）**：configSchema 暴露 `allowedHosts`/`blockedHosts`/是否允许私网/最大 body，默认宽松；不做强制安全限制。high + 默认禁用。

#### B2 — `data_transform`（JSON/YAML/CSV/TOML 处理转换）
- `data` / builtin / **low** / **默认启用**。timeoutMs 10000。
- **inputSchema**：`input`(内联) **或** `path`(workspace 文件，二选一) / `from`(json/yaml/csv/toml，自动探测) / `to` / `query`(JSONPath/简单路径) / `pretty`。
- **handler**：复用 structured-data.mjs 纯函数；文件输入走 readWorkspaceTextFile（只读，落盘让模型再调 write_file）；大小上限。
- **UI**：renderType `data-table`（数组渲染表格）或代码块。
- **风险/决策**：第三方 yaml/csv 库依赖范围确认（否则纯 JSON + 轻量自实现 CSV）。

#### B3 — `csv_inspect`（大表格智能预览/统计）
- `data` / builtin / **low** / 默认启用。timeoutMs 10000。
- **inputSchema**：`path`(必填) / `delimiter` / `sampleRows` / `stats`(bool)。
- **handler**：readWorkspaceTextFile + structured-data CSV 解析 + 列统计（类型/空值/唯一值）。只读。给模型探索大表的轻量入口（避免整表塞 context）。
- **UI**：`data-table`。

#### B4 — `text_diff`（文本/文件对比）
- `data` / builtin / **low** / **默认启用**。timeoutMs 10000。
- **inputSchema**：`leftPath`/`rightPath`(文件) **或** `leftText`/`rightText`(内联) / `context`(行数) / `ignoreWhitespace`。
- **handler**：文件走 readWorkspaceTextFile（只读）；轻量 LCS diff。
- **UI**：renderType `diff-view`（与 apply_patch 共享）。

#### B5 — `file_download`（下载 URL 到 workspace）
- `integration` / builtin / **high** / **默认禁用**。timeoutMs 60000。
- **inputSchema**：`url`(必填) / `path`(workspace 目标，必填) / `overwrite` / `maxBytes`。
- **handler**：http-client 下载 + write_file 同款**路径越界校验**落盘（仅防写出 workspace，非安全门禁）；二进制扩展名默认放开（不沿用 BLOCKED_EXTENSIONS 写限制）；可 emit 进度；大小上限仅作稳定性保护。
- **UI**：复用 `file-write` 或 `http-response`。
- **策略（用户可配置）**：允许的扩展名/最大大小由 configSchema 配置，默认宽松。

#### B6 — `archive`（压缩/解压）
- `data` / builtin / **high** / **默认禁用**。timeoutMs 60000。
- **inputSchema**：`action`(compress/extract/list，必填) / `source`(必填) / `dest` / `format`(zip/tar/tar.gz)。
- **handler**：source/dest 走 resolveWorkspaceDirectoryPath/写路径越界校验；解压条目逐条 relative 校验落在 dest 内（防路径穿越，功能正确性）；文件数/总大小上限作稳定性保护。
- **UI**：renderType `archive-result`。
- **风险/决策**：写二进制归档到 workspace 默认放开；依赖 tar/zip 库。

#### B7 — `encode`（编码转换/hash）
- `data` / builtin / **low** / **默认启用**。timeoutMs 3000。
- **inputSchema**：`operation`(base64_encode/decode / url_encode/decode / hex / sha256 / md5 / ...，必填) / `input`(必填)。
- **handler**：纯 Node 内置（Buffer / crypto / encodeURIComponent），无 IO。
- **UI**：普通文本块，无需自定义。**最简样板，验证最小工具流程。**

#### B8 — `sqlite_query`（本地 SQLite 只读查询）
- `data` / builtin / **high** / **默认禁用**。timeoutMs 15000。
- **inputSchema**：`dbPath`(workspace 相对，必填) / `sql`(必填) / `params`(array) / `maxRows`。
- **handler**：resolveWorkspaceFilePath（`.sqlite/.db` 在 BLOCKED_EXTENSIONS 需放宽**读取**）→ node:sqlite **只读模式** open → SQL 必须 SELECT/WITH 开头（功能约束）；结果行数上限。
- **UI**：renderType `db-result`（复用 data-table）。
- **风险/决策**：只读强制需确认 node:sqlite 只读 open 能力；是否屏蔽自身库由 configSchema 配置。

#### B9 — `secret_get`（读取 secrets）
- `system` / builtin / **high** / **默认禁用**。timeoutMs 3000。
- **inputSchema**：`name`(必填，密钥名)。
- **handler**：从 secrets 存储（key=`tool-secrets`，设置页配置）按 name 取值；可选 scrubRunRecord 打码（是否打码由用户配置）。
- **UI**：renderType `notify-result` 风格；client.mjs 维护密钥列表；key `tool-secrets`。
- **策略（用户可配置）**：是否限制密钥名清单、是否脱敏运行记录均由 configSchema 配置，默认放开；high + 默认禁用。

#### B10 — `yaml_toml`（YAML/TOML 专项校验/格式化）
- `data` / builtin / **low** / 默认启用。timeoutMs 5000。
- **inputSchema**：`action`(validate/format/to_json，必填) / `input` 或 `path` / `format`(yaml/toml)。
- **handler**：复用 structured-data.mjs；只读 + 返回结果。聚焦配置文件场景（CI/部署配置校验）。
- **UI**：代码块。

#### B11 — `jq_query`（JSON 路径/jq 风格查询）
- `data` / builtin / **low** / 默认启用。timeoutMs 5000。
- **inputSchema**：`input` 或 `path`(必填二选一) / `query`(jq 风格表达式，必填)。
- **handler**：复用 structured-data.mjs 的路径求值；只读。给模型从大 JSON 精确取值的能力（避免整 JSON 塞 context）。
- **UI**：代码块或 `data-table`。

---

### 方向 C：贴合 xwork 自身场景（7 个工具）

#### C1 — `notify`（消息通知发送）
- `integration` / builtin / **medium** / **默认禁用**。timeoutMs 15000。
- **inputSchema**：`target`(feishu/wecom/dingtalk/slack/custom，必填) / `text`(必填) / `title` / `webhookId`(引用预存) 或 `webhookUrl`。
- **handler**：http-client POST；webhook 优先从预存列表（key=`tool-notify`）按 id 取；各平台 payload 适配（飞书 msg_type:text 等）。
- **UI**：renderType `notify-result`；client.mjs 配置 webhook 列表；key `tool-notify`。
- **策略（用户可配置）**：是否允许任意 custom URL 由 configSchema 开关控制，默认放开。

#### C2 — `feishu_write`（飞书写入/评论）
- `feishu` / builtin / **high** / **默认禁用**。timeoutMs 30000。
- **inputSchema**：`action`(append_doc_block/write_sheet_range/add_comment，必填) / `docToken`/`spreadsheetToken` / `content`/`range`/`values`/`commentText`。
- **handler**：**复用 feishu-oauth.mjs** token 获取，但需**新增写权限 scope**（现有只有 readonly，要加 `docx:document`/`sheets:spreadsheet`/comment 写 scope）；调飞书 OpenAPI 写接口；可选 read-back 校验。
- **UI**：复用 feishu renderType；沿用 feishu-auth token。
- **风险/决策（重大）**：写 scope 需用户重新走 device-flow 授权；写飞书不可逆，high + 默认禁用 + 建议 ask_user 前置确认。**已确认纳入**。

#### C3 — `conversation_search`（会话检索）
- `agent` / builtin / **low** / **默认禁用**。timeoutMs 15000。
- **inputSchema**：`query`(必填) / `limit` / `channelId` / `since`。
- **handler**：listConversationDocuments()（只读）→ 标题/消息文本关键词匹配 + 评分 + 截取片段；片段长度控制。
- **UI**：renderType `conversation-results`。
- **风险/决策**：全量扫描性能（会话多时考虑倒排索引，P2）。

#### C4 — `usage_query`（用量/成本分析）
- `agent` / builtin / **low** / **默认启用**。timeoutMs 10000。
- **inputSchema**：`limit` / `includeTest`(bool) / `groupBy`(model/channel/day)。
- **handler**：**直接复用 `buildUsageReport({limit,includeTest})`** + 按 groupBy 聚合。只读。
- **UI**：renderType `usage-report`。**复用现成函数，P0 友好。**

#### C5 — `channel_health`（渠道健康检查/测速）
- `agent` / builtin / **medium** / **默认禁用**。timeoutMs 30000。
- **inputSchema**：`channelId`(缺省测全部) / `probeType`(ping/models/min_completion)。
- **handler**：从 config channels[] 取 baseUrl/apiKey，http-client 发轻量请求（GET /models 或 1-token completion）测延迟/状态；apiKey 不回传模型（scrub）。
- **UI**：renderType `channel-health`（延迟表/红绿灯）。
- **风险/决策**：min_completion 产生真实费用，默认用最轻探测。

#### C6 — `expert_agent_manage`（专家 agent 管理）
- `agent` / builtin / **high** / **默认禁用**。timeoutMs 10000。
- **inputSchema**：`action`(list/get/create/update/delete，必填) / `id` / `profile`(title/description/selectionPrompt/allowedTools/maxTurns)。
- **handler**：**直接复用 `lib/agents/profiles.mjs`**（key=`expert-agents`）；校验 allowedTools 必须是已注册工具。
- **UI**：renderType `expert-agent-list`；复用 expert-agents key。
- **风险/决策**：模型自改 agent 能力 = 权限放大；high + 默认禁用 + create/update 前置 ask_user。

#### C7 — `team_message`（多 Agent 协作消息）
- **对标**：SendMessage。`agent` / builtin / **medium** / **默认禁用**。timeoutMs 10000。
- **inputSchema**：`to`(agent/role，必填) / `summary`(必填) / `message`(必填)。
- **handler**：写共享消息总线（key=`tool-team-messages`，按 rootRunId 分组），供 runSubagent 启动的子代理轮次间读取；依赖 context.rootRunId/parentRunId。
- **UI**：renderType `team-message`；key `tool-team-messages`。
- **风险/决策（重大）**：xwork 子代理是 fork-join 模型，无长期存活 teammate；真正双向协作需**重构 subagent-runtime 支持持久 teammate + 投递唤醒**。**已确认纳入**（先做消息总线 + 子代理读取，持久 teammate 重构为后续里程碑）。

---

## 三、总览表（28 个）

| # | id | 方向 | 对标 CC | category | danger | 默认启用 |
|---|---|---|---|---|---|---|
| 1 | task | A | TaskCreate/List/Update/Get | productivity | low | 是 |
| 2 | memory | A | Memory | productivity | medium | 否 |
| 3 | bg_shell | A | run_in_background | system | high | 否 |
| 4 | bg_output | A | TaskOutput | system | low | 否 |
| 5 | bg_stop | A | TaskStop/KillShell | system | medium | 否 |
| 6 | cron_create | A | CronCreate | productivity | high | 否 |
| 7 | cron_manage | A | CronList/CronDelete | productivity | low | 否 |
| 8 | apply_patch | A | apply_patch/MultiEdit | system | high | 是 |
| 9 | notebook_edit | A | NotebookEdit | system | high | 否 |
| 10 | plan_confirm | A | ExitPlanMode | agent | low | 是 |
| 11 | http_request | B | (MCP fetch) | integration | high | 否 |
| 12 | data_transform | B | — | data | low | 是 |
| 13 | csv_inspect | B | — | data | low | 是 |
| 14 | text_diff | B | — | data | low | 是 |
| 15 | file_download | B | — | integration | high | 否 |
| 16 | archive | B | — | data | high | 否 |
| 17 | encode | B | — | data | low | 是 |
| 18 | sqlite_query | B | — | data | high | 否 |
| 19 | secret_get | B | — | system | high | 否 |
| 20 | yaml_toml | B | — | data | low | 是 |
| 21 | jq_query | B | — | data | low | 是 |
| 22 | notify | C | — | integration | medium | 否 |
| 23 | feishu_write | C | — | feishu | high | 否 |
| 24 | conversation_search | C | — | agent | low | 否 |
| 25 | usage_query | C | — | agent | low | 是 |
| 26 | channel_health | C | — | agent | medium | 否 |
| 27 | expert_agent_manage | C | (TeamCreate) | agent | high | 否 |
| 28 | team_message | A | SendMessage | agent | medium | 否 |

---

## 四、建议优先实现顺序

### P0（地基 + 低风险高价值样板）
- **地基**：`_shared/doc-store-helpers.mjs`、`_shared/structured-data.mjs`、新 category `productivity`/`data`、key `tool-tasks`。
- **工具**：`encode`（最简样板，跑通最小工具流程）、`text_diff` + `diff-view`、`data_transform`、`csv_inspect`、`yaml_toml`、`jq_query`、`usage_query`（复用 buildUsageReport）、`task`（多 action 任务清单）。
- **理由**：全部 low / 无网络无破坏性 / 复用现成函数，快速验证 ui.mjs+renderType+持久化+parseResult 全链路，立即提升 agent 多步任务管理与数据处理能力。

### P1（高价值，需新基础设施或交互改造）
- **地基**：`_shared/http-client.mjs`、`_shared/shell-safety.mjs`、key `tool-memory`/`tool-notify`/`tool-secrets`、新 category `integration`。
- **工具**：`apply_patch`（本批最高优先，补多文件编辑短板）、`memory`、`plan_confirm`（复用 ask_user）、`http_request`、`file_download`、`notify`、`conversation_search`、`channel_health`、`notebook_edit`。

### P2（框架级改动 / 高风险，已确认全部纳入）
- **地基**：`_shared/background-tasks.mjs`、`lib/cron-runner.mjs`（常驻调度服务）、key `tool-cron`/`tool-team-messages`。
- **工具**：`bg_shell`/`bg_output`/`bg_stop`、`cron_create`/`cron_manage`、`feishu_write`（需写 scope + 重新 OAuth）、`sqlite_query`、`secret_get`、`archive`、`expert_agent_manage`、`team_message`（需重构 subagent 为持久 teammate，先做消息总线版）。

---

## 五、宁筠已拍板的策略约定（实现时遵循）

1. **不做图像理解**：原 understand_image 已移除，替换为 notebook_edit。
2. **策略由用户配置**：vision、host 白名单、扩展名白名单、密钥名清单等一律不在工具里硬编码默认约束，统一通过各工具 `configSchema` 暴露给用户在 Tools 设置页配置（默认值可宽松）。
3. **不预设安全限制**：file_download/archive 的二进制写 workspace、secrets/http_request 的 host/密钥白名单**不做强制安全约束**，按要求放开（仅保留功能性的路径越界校验与大小上限，作为稳定性而非安全门禁）。
4. **cron 触发目标**（A6）：定时任务触发时 prompt 投到哪个 conversation/channel/model，实现时定义一个默认策略（如沿用注册时的 conversation + 活跃 channel/model），后续可配置。
5. **feishu_write 写 scope 授权流程**（C2，**已确认要做**）：扩展 FEISHU_DOMAIN_SCOPES 写权限，用户重新走 device-flow 同意写权限。

---

## 六、验证方式（实现后如何端到端测试）

每个工具实现后，按 TOOL.md 的「新建工具 Checklist」验证：

1. **加载验证**：重启服务（`npm run dev`），`GET /api/v1/tools` 确认新工具出现、enabled/dangerLevel 正确；加载失败会显示 `adapter:'unavailable'`。
2. **manifest 验证**：`GET /api/v1/tools/ui-manifest` 确认含自定义渲染的工具进入前端 manifest。
3. **单元测试**：每个工具 colocated `lib/tools/<slug>/test.mjs`（node:test），覆盖注册 + handler 正常/异常/边界。运行 `npm test`。
4. **架构契约**：在 `test/architecture.test.mjs` 补断言（如新 category 合法、resolveDefinition 字节稳定）。
5. **端到端**：在聊天页实际触发工具调用，确认 SSE 流式 + parseResult 渲染 + 历史消息恢复三条链路均正常；高危工具确认默认禁用且启用后 dangerLevel 提示正确。
6. **回归**：确认现有 19 个工具与全部测试不受新 category/新 _shared 模块影响。
