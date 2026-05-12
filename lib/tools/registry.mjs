import { builtinTools } from './builtin/index.mjs';
import { readToolConfigs, writeToolConfigs } from './store.mjs';

const tools = builtinTools;

function publicTool(tool, config) {
  return {
    id: tool.id,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    category: tool.category,
    adapter: tool.adapter,
    version: tool.version,
    dangerLevel: tool.dangerLevel,
    enabled: config.enabled,
    timeoutMs: config.timeoutMs,
    maxUses: tool.maxUses,
    type: tool.type,
    inputSchema: tool.inputSchema,
  };
}

export async function listTools() {
  const configs = await readToolConfigs(tools);
  const configById = new Map(configs.map(config => [config.id, config]));
  return tools.map(tool => publicTool(tool, configById.get(tool.id)));
}

export async function getEnabledToolDefinitions() {
  const configs = await readToolConfigs(tools);
  const enabledIds = new Set(configs.filter(config => config.enabled).map(config => config.id));
  return tools
    .filter(tool => enabledIds.has(tool.id))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      adapter: tool.adapter,
      type: tool.type,
      maxUses: tool.maxUses,
      allowedDomains: tool.allowedDomains,
      blockedDomains: tool.blockedDomains,
    }));
}

export async function getToolRuntime(name) {
  const tool = tools.find(item => item.name === name);
  if (!tool) return null;
  if (tool.adapter === 'anthropic_server') return null;

  const configs = await readToolConfigs(tools);
  const config = configs.find(item => item.id === tool.id);
  if (!config?.enabled) return null;

  return {
    tool,
    config,
  };
}

export async function updateToolConfig(id, patch) {
  if (!tools.find(tool => tool.id === id)) return null;

  const configs = await readToolConfigs(tools);
  const nextConfigs = configs.map(config => {
    if (config.id !== id) return config;
    return {
      ...config,
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
      ...(patch.timeoutMs !== undefined ? { timeoutMs: Number(patch.timeoutMs) || config.timeoutMs } : {}),
      ...(patch.config !== undefined && typeof patch.config === 'object' ? { config: patch.config } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  await writeToolConfigs(nextConfigs);

  const updated = nextConfigs.find(config => config.id === id);
  const tool = tools.find(item => item.id === id);
  return publicTool(tool, updated);
}
