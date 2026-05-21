import { loadBuiltinTools } from './builtin/index.mjs';
import { readToolConfigs, writeToolConfigs } from './store.mjs';
import { validateToolConfigPatch } from '../schema.mjs';

async function getTools() {
  return loadBuiltinTools();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function configuredValue(config, key, fallback) {
  const value = plainObject(config)[key];
  return value === undefined ? fallback : value;
}

function configuredInteger(config, key, fallback, { min = 1, max = 300000 } = {}) {
  const value = configuredValue(config, key, fallback);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function configuredStringArray(config, key, fallback) {
  const value = configuredValue(config, key, fallback);
  if (!Array.isArray(value)) return fallback;
  return value.map(item => String(item).trim()).filter(Boolean);
}

function publicTool(tool, config) {
  const toolConfig = plainObject(config?.config);
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
    defaultTimeoutMs: tool.timeoutMs || 10000,
    config: toolConfig,
    defaultConfig: plainObject(tool.defaultConfig),
    configSchema: plainObject(tool.configSchema),
    configExamples: Array.isArray(tool.configExamples) ? tool.configExamples : [],
    maxUses: configuredInteger(toolConfig, 'maxUses', tool.maxUses, { min: 1, max: 100 }),
    type: tool.apiToolType || tool.type,
    inputSchema: tool.inputSchema,
    unavailable: tool.unavailable === true,
    loadError: tool.loadError,
  };
}

function configuredToolDefinition(tool, config = {}) {
  const toolConfig = plainObject(config.config);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    adapter: tool.adapter,
    type: configuredValue(toolConfig, 'type', tool.apiToolType || tool.type),
    maxUses: configuredInteger(toolConfig, 'maxUses', tool.maxUses, { min: 1, max: 100 }),
    allowedDomains: configuredStringArray(toolConfig, 'allowedDomains', tool.defaultConfig?.allowedDomains ?? tool.allowedDomains),
    blockedDomains: configuredStringArray(toolConfig, 'blockedDomains', tool.defaultConfig?.blockedDomains ?? tool.blockedDomains),
    systemPrompt: tool.systemPrompt,
    parseStreamResult: tool.parseStreamResult,
    parseResult: tool.parseResult,
  };
}

export async function listTools() {
  const tools = await getTools();
  const configs = await readToolConfigs(tools);
  const configById = new Map(configs.map(config => [config.id, config]));
  return tools.map(tool => publicTool(tool, configById.get(tool.id)));
}

export async function getEnabledToolDefinitions() {
  const tools = await getTools();
  const configs = await readToolConfigs(tools);
  const enabledIds = new Set(configs.filter(config => config.enabled).map(config => config.id));
  const configById = new Map(configs.map(config => [config.id, config]));
  return tools
    .filter(tool => enabledIds.has(tool.id) && tool.adapter !== 'unavailable')
    .map(tool => configuredToolDefinition(tool, configById.get(tool.id)));
}

export async function getToolRuntime(name) {
  const tools = await getTools();
  const tool = tools.find(item => item.name === name);
  if (!tool) return null;
  if (tool.adapter === 'unavailable') {
    return {
      tool,
      config: { enabled: false, timeoutMs: 0, config: {} },
      unavailable: true,
    };
  }
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
  const tools = await getTools();
  if (!tools.find(tool => tool.id === id)) return null;
  const safePatch = validateToolConfigPatch(patch || {});

  const configs = await readToolConfigs(tools);
  const nextConfigs = configs.map(config => {
    if (config.id !== id) return config;
    return {
      ...config,
      ...(safePatch.enabled !== undefined ? { enabled: safePatch.enabled } : {}),
      ...(safePatch.timeoutMs !== undefined ? { timeoutMs: safePatch.timeoutMs } : {}),
      ...(safePatch.config !== undefined ? { config: safePatch.config } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  await writeToolConfigs(nextConfigs);

  const updated = nextConfigs.find(config => config.id === id);
  const tool = tools.find(item => item.id === id);
  return publicTool(tool, updated);
}
