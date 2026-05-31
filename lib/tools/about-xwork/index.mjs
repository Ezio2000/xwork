import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, '..', '..', '..', 'package.json');

let _pkg;
function readPkg() {
  if (!_pkg) {
    try {
      _pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    } catch {
      _pkg = {};
    }
  }
  return _pkg;
}

const QUERIES = {
  project: 'xwork 项目概述：是什么、核心架构、技术栈',
  channels: '渠道配置列表摘要：仅含 id、名称、是否活跃。如需查看某个渠道的完整配置（含模型列表、baseUrl、API Key 是否存在等），请用 channel 查询',
  channel: '单个渠道完整详情：含 baseUrl、模型列表、API Key 是否存在等。需传 channelId',
  tools: '所有工具摘要列表：仅含 id、名称、分类、是否启用。如需查看某个工具的完整配置（inputSchema、超时、config 等），请用 tool 查询',
  tool: '单个工具完整详情：含 inputSchema、超时、默认配置、configSchema、configExamples 等。需传 toolId',
  workspace: '当前工作区根目录路径和标签',
  active_model: '当前活跃的渠道 ID 和模型 ID',
  version: 'xwork 版本号与运行环境信息',
};

function systemPrompt() {
  return [
    'about_xwork tool policy:',
    '- Use about_xwork when you need to understand your own configuration, capabilities, or environment.',
    '- You MUST pass the "query" parameter to specify which aspect to inspect.',
    '- For overview/summary, use plural queries: "channels" and "tools" return brief lists.',
    '- For full detail on a single item, use singular queries: "channel" (requires channelId) or "tool" (requires toolId).',
    '- Available queries:',
    ...Object.entries(QUERIES).map(([key, desc]) => `  - ${key}: ${desc}`),
    '- Call this tool only for the specific information you need. Do NOT enumerate all queries in one turn unless truly necessary.',
    '- If unsure which query covers your need, start with "project" for an overview.',
  ].join('\n');
}

export const tool = {
  id: 'about_xwork',
  name: 'about_xwork',
  title: 'About Xwork',
  description: '查询 xwork 自身的配置和运行状态。必须通过 query 参数指定要查询的模块。',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 5000,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: `要查询的模块。可选值：${Object.keys(QUERIES).join(', ')}。用 "channels"/"tools" 查看列表摘要，用 "channel"/"tool" 查看单个详情。`,
        enum: Object.keys(QUERIES),
      },
      channelId: {
        type: 'string',
        description: '当 query 为 "channel" 时必填，指定要查看详情的渠道 ID。先用 "channels" 获取渠道 ID 列表。',
      },
      toolId: {
        type: 'string',
        description: '当 query 为 "tool" 时必填，指定要查看详情的工具 ID。先用 "tools" 获取工具 ID 列表。',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  systemPrompt,
  async handler({ query, channelId, toolId }) {
    switch (query) {
      case 'project':
        return projectInfo();
      case 'channels':
        return channelsList();
      case 'channel': {
        if (!channelId) return { error: 'channelId is required when query is "channel"' };
        return channelDetail(channelId);
      }
      case 'tools':
        return toolsList();
      case 'tool': {
        if (!toolId) return { error: 'toolId is required when query is "tool"' };
        return toolDetail(toolId);
      }
      case 'workspace':
        return workspaceInfo();
      case 'active_model':
        return activeModelInfo();
      case 'version':
        return versionInfo();
      default:
        return { error: `unknown query: ${query}`, available: Object.keys(QUERIES) };
    }
  },

  parseResult(output) {
    return {
      renderType: 'about-xwork',
      data: {
        ...output,
        query: output.query || '',
        title: output.title || output.name || 'xwork',
      },
    };
  },
};

function projectInfo() {
  const pkg = readPkg();
  return {
    query: 'project',
    name: pkg.name || 'xwork',
    version: pkg.version || 'unknown',
    description: pkg.description || '',
    summary: 'xwork 是一个自托管的 AI 聊天服务，兼容 Anthropic Messages API 协议。支持多渠道/多模型配置、自动工具调用循环、子代理委派、SSE 流式响应和后台运行重连。',
    techStack: {
      runtime: 'Node.js (ESM, 无构建步骤)',
      storage: 'SQLite (data/xwork.sqlite)',
      frontend: '纯静态 HTML/CSS/JS (MVC 模式)',
    },
    architecture: {
      entry: 'server.mjs (Express)',
      coreModules: [
        'lib/query-loop.mjs — 多轮工具调用循环',
        'lib/providers/ — 供应商适配器 (Anthropic 协议)',
        'lib/tools/ — 工具注册、调度、执行引擎',
        'lib/agents/ — 子代理委派运行时',
        'lib/chat/ — 聊天服务、对话持久化、渠道配置',
        'lib/storage.mjs — SQLite 对话存储',
      ],
      routes: '/api/v1 下挂载 channels, chat, conversations, tools, agents, usage, pricing, workspace',
      tools: '19 个 builtin 工具（含 ask_user, about_xwork）',
    },
  };
}

async function channelsList() {
  let config;
  try {
    const { readConfig } = await import('../../config-store.mjs');
    config = await readConfig();
  } catch {
    config = {};
  }
  const channels = (config.channels || []).map(ch => ({
    id: ch.id,
    name: ch.name,
    isActive: ch.id === config.activeChannelId,
    hasApiKey: !!ch.apiKey,
    modelCount: (ch.models || []).length,
  }));
  return {
    query: 'channels',
    title: '渠道列表',
    activeChannelId: config.activeChannelId || null,
    activeModel: config.activeModel || null,
    channelCount: channels.length,
    channels,
    hint: '使用 query="channel" + channelId 查看单个渠道的完整详情',
  };
}

async function channelDetail(channelId) {
  let config;
  try {
    const { readConfig } = await import('../../config-store.mjs');
    config = await readConfig();
  } catch {
    config = {};
  }
  const ch = (config.channels || []).find(c => c.id === channelId);
  if (!ch) return { error: `channel not found: ${channelId}`, query: 'channel' };
  return {
    query: 'channel',
    title: `渠道: ${ch.name}`,
    id: ch.id,
    name: ch.name,
    baseUrl: ch.baseUrl,
    hasApiKey: !!ch.apiKey,
    isActive: ch.id === config.activeChannelId,
    models: (ch.models || []).map(m => ({
      id: m.id,
      name: m.name,
      maxTokens: m.maxTokens,
      maxTurns: m.maxTurns,
      ...(m.pricing ? { pricing: m.pricing } : {}),
    })),
    ...(ch.extraHeaders && Object.keys(ch.extraHeaders).length > 0 ? { extraHeadersCount: Object.keys(ch.extraHeaders).length } : {}),
  };
}

async function toolsList() {
  let tools;
  try {
    const { listTools } = await import('../registry.mjs');
    tools = await listTools();
  } catch {
    tools = [];
  }
  return {
    query: 'tools',
    title: '工具列表',
    toolCount: tools.length,
    enabledCount: tools.filter(t => t.enabled).length,
    disabledCount: tools.filter(t => !t.enabled).length,
    tools: tools.map(t => ({
      id: t.id,
      name: t.name,
      title: t.title,
      category: t.category,
      enabled: t.enabled,
      unavailable: t.unavailable || false,
    })),
    hint: '使用 query="tool" + toolId 查看单个工具的完整详情（含 inputSchema、config 等）',
  };
}

async function toolDetail(toolId) {
  let tools;
  try {
    const { listTools } = await import('../registry.mjs');
    tools = await listTools();
  } catch {
    tools = [];
  }
  const t = tools.find(item => item.id === toolId || item.name === toolId);
  if (!t) return { error: `tool not found: ${toolId}`, query: 'tool' };
  return {
    query: 'tool',
    title: `工具: ${t.title}`,
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: t.category,
    adapter: t.adapter,
    version: t.version,
    dangerLevel: t.dangerLevel,
    enabled: t.enabled,
    timeoutMs: t.timeoutMs,
    defaultTimeoutMs: t.defaultTimeoutMs,
    unavailable: t.unavailable || false,
    maxUses: t.maxUses,
    config: t.config || {},
    defaultConfig: t.defaultConfig,
    configSchema: t.configSchema,
    configExamples: t.configExamples || [],
    inputSchema: t.inputSchema,
    type: t.type,
  };
}

async function workspaceInfo() {
  let config;
  try {
    const { readConfig } = await import('../../config-store.mjs');
    config = await readConfig();
  } catch {
    config = {};
  }
  const ws = config.workspace || {};
  return {
    query: 'workspace',
    title: '工作区配置',
    root: ws.root || null,
    label: ws.label || null,
    defaultWorkspace: !ws.root,
  };
}

async function activeModelInfo() {
  let config;
  try {
    const { readConfig } = await import('../../config-store.mjs');
    config = await readConfig();
  } catch {
    config = {};
  }
  const activeChannel = (config.channels || []).find(ch => ch.id === config.activeChannelId);
  const activeModelMeta = activeChannel
    ? (activeChannel.models || []).find(m => m.id === config.activeModel)
    : null;
  return {
    query: 'active_model',
    title: '当前活跃模型',
    activeChannelId: config.activeChannelId || null,
    activeChannelName: activeChannel?.name || null,
    activeModel: config.activeModel || null,
    activeModelName: activeModelMeta?.name || null,
    activeModelMaxTokens: activeModelMeta?.maxTokens || null,
    activeModelMaxTurns: activeModelMeta?.maxTurns || null,
    totalChannels: (config.channels || []).length,
  };
}

async function versionInfo() {
  const pkg = readPkg();
  return {
    query: 'version',
    title: '版本信息',
    name: pkg.name || 'xwork',
    version: pkg.version || 'unknown',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}
