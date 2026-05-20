import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteDocumentStore } from '../sqlite-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_PATH = join(__dirname, '..', '..', 'data', 'tools.json');

function defaultToolConfig(tool) {
  return {
    id: tool.id,
    enabled: tool.unavailable ? false : tool.defaultEnabled !== false,
    timeoutMs: tool.timeoutMs || 10000,
    config: {},
    updatedAt: new Date().toISOString(),
  };
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
    return {
      ...defaults,
      ...current,
      id: tool.id,
      enabled: tool.unavailable ? false : current.enabled,
      config: current.config && typeof current.config === 'object' ? current.config : {},
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
