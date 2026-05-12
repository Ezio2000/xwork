import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_PATH = join(__dirname, '..', '..', 'data', 'tools.json');

function defaultToolConfig(tool) {
  return {
    id: tool.id,
    enabled: tool.defaultEnabled !== false,
    timeoutMs: tool.timeoutMs || 10000,
    config: {},
    updatedAt: new Date().toISOString(),
  };
}

async function ensureToolsFile(tools) {
  const dir = dirname(TOOLS_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  if (!existsSync(TOOLS_PATH)) {
    const configs = tools.map(defaultToolConfig);
    await writeFile(TOOLS_PATH, JSON.stringify({ tools: configs }, null, 2));
    return configs;
  }
  return null;
}

export async function readToolConfigs(tools) {
  const created = await ensureToolsFile(tools);
  if (created) return created;

  let data;
  try {
    data = JSON.parse(await readFile(TOOLS_PATH, 'utf-8'));
  } catch {
    data = { tools: [] };
  }

  const existing = Array.isArray(data.tools) ? data.tools : [];
  const byId = new Map(existing.map(item => [item.id, item]));
  let changed = false;
  const configs = tools.map(tool => {
    const current = byId.get(tool.id);
    if (!current) {
      changed = true;
      return defaultToolConfig(tool);
    }
    return {
      ...defaultToolConfig(tool),
      ...current,
      id: tool.id,
      config: current.config && typeof current.config === 'object' ? current.config : {},
    };
  });

  if (changed || configs.length !== existing.length) {
    await writeToolConfigs(configs);
  }
  return configs;
}

export async function writeToolConfigs(configs) {
  const dir = dirname(TOOLS_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(TOOLS_PATH, JSON.stringify({ tools: configs }, null, 2));
}
