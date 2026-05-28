import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteDocumentStore } from '../sqlite-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_PATH = join(__dirname, '..', '..', 'data', 'tools.json');

function defaultToolConfig(tool) {
  const defaultConfig = tool.defaultConfig && typeof tool.defaultConfig === 'object' && !Array.isArray(tool.defaultConfig)
    ? { ...tool.defaultConfig }
    : {};
  return {
    id: tool.id,
    enabled: tool.unavailable ? false : tool.defaultEnabled !== false,
    timeoutMs: tool.timeoutMs || 10000,
    defaultTimeoutMs: tool.timeoutMs || 10000,
    config: defaultConfig,
    updatedAt: new Date().toISOString(),
  };
}

function legacyTimeouts(tool) {
  const values = Array.isArray(tool.legacyTimeoutMs) ? tool.legacyTimeoutMs : [];
  return new Set(values.map(value => Number(value)).filter(Number.isInteger));
}

function migratedTimeoutMs(current, defaults, tool) {
  const n = Number(current?.timeoutMs);
  const fallback = defaults.timeoutMs;
  if (!Number.isInteger(n) || n < 1) return fallback;
  const recordedDefault = Number(current?.defaultTimeoutMs);
  const defaultChanged = !Number.isInteger(recordedDefault) || recordedDefault !== defaults.defaultTimeoutMs;
  if (defaultChanged && legacyTimeouts(tool).has(n)) return fallback;
  return n;
}

const toolsStore = createSqliteDocumentStore({
  key: 'tools',
  legacyFilePath: TOOLS_PATH,
  defaultValue: { tools: [] },
  normalize: data => ({ tools: Array.isArray(data?.tools) ? data.tools : [] }),
  serialize: data => ({ tools: Array.isArray(data?.tools) ? data.tools : [] }),
});

export async function readToolConfigs(tools) {
  const data = await toolsStore.read();
  const existing = Array.isArray(data.tools) ? data.tools : [];
  const byId = new Map(existing.map(item => [item.id, item]));
  let changed = false;
  const configs = tools.map(tool => {
    const current = byId.get(tool.id);
    if (!current) {
      changed = true;
      return defaultToolConfig(tool);
    }
    const defaults = defaultToolConfig(tool);
    const currentConfig = current.config && typeof current.config === 'object' && !Array.isArray(current.config)
      ? current.config
      : {};
    const config = { ...defaults.config, ...currentConfig };
    if (JSON.stringify(config) !== JSON.stringify(current.config || {})) {
      changed = true;
    }
    const timeoutMs = migratedTimeoutMs(current, defaults, tool);
    if (timeoutMs !== current.timeoutMs || current.defaultTimeoutMs !== defaults.defaultTimeoutMs) {
      changed = true;
    }
    return {
      ...defaults,
      ...current,
      id: tool.id,
      enabled: tool.unavailable ? false : current.enabled,
      timeoutMs,
      defaultTimeoutMs: defaults.defaultTimeoutMs,
      config,
    };
  });

  if (changed || configs.length !== existing.length) {
    await writeToolConfigs(configs);
  }
  return configs;
}

export async function writeToolConfigs(configs) {
  await toolsStore.write({ tools: configs });
}

export async function readStoredToolConfig(id) {
  const data = await toolsStore.read();
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const current = tools.find(item => item?.id === id);
  const config = current?.config && typeof current.config === 'object' && !Array.isArray(current.config)
    ? current.config
    : {};
  return { ...config };
}

export async function patchStoredToolConfig(id, mutator) {
  return toolsStore.update(data => {
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const current = tools.find(item => item?.id === id);
    if (!current) return null;
    const config = current.config && typeof current.config === 'object' && !Array.isArray(current.config)
      ? current.config
      : {};
    const nextConfig = mutator({ ...config }) || config;
    current.config = nextConfig && typeof nextConfig === 'object' && !Array.isArray(nextConfig) ? nextConfig : config;
    current.updatedAt = new Date().toISOString();
    return current;
  });
}
