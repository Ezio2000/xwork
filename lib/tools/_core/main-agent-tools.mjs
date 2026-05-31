import { loadTools } from '../loader.mjs';
import { readToolConfigs } from './store.mjs';

function toolName(tool) {
  return tool?.name || tool?.id || '';
}

export async function listMainAgentEnabledToolNames() {
  const tools = await loadTools();
  const configs = await readToolConfigs(tools);
  const enabledIds = new Set(
    configs
      .filter(config => config?.enabled)
      .map(config => config.id),
  );
  return tools
    .filter(tool => enabledIds.has(tool.id) && tool.adapter !== 'unavailable')
    .map(toolName)
    .filter(Boolean);
}

export async function mainAgentEnabledToolNameSet() {
  return new Set(await listMainAgentEnabledToolNames());
}

export function filterToolsByEnabledNames(toolNames = [], enabledNames = new Set()) {
  const out = [];
  const seen = new Set();
  for (const rawName of Array.isArray(toolNames) ? toolNames : []) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || seen.has(name) || !enabledNames.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function disabledToolNames(toolNames = [], enabledNames = new Set()) {
  const out = [];
  const seen = new Set();
  for (const rawName of Array.isArray(toolNames) ? toolNames : []) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || seen.has(name) || enabledNames.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
