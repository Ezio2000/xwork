const builtinToolLoaders = [
  ['get_current_time', () => import('./current-time.mjs'), 'currentTimeTool'],
  ['web_search', () => import('./web-search.mjs'), 'webSearchTool'],
  ['calculator', () => import('./calculator.mjs'), 'calculatorTool'],
  ['uuid_gen', () => import('./uuid-gen.mjs'), 'uuidGenTool'],
  ['delegate_task', () => import('./delegate-task.mjs'), 'delegateTaskTool'],
  ['web_fetch', () => import('./web-fetch.mjs'), 'webFetchTool'],
];

function unavailableTool(id, err) {
  const message = err?.message || String(err || 'Unknown load error');
  return {
    id,
    name: id,
    title: id,
    description: `Tool failed to load and is unavailable: ${message}`,
    category: 'unavailable',
    adapter: 'unavailable',
    version: '0.0.0',
    dangerLevel: 'unknown',
    defaultEnabled: false,
    timeoutMs: 0,
    unavailable: true,
    loadError: message,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  };
}

async function loadBuiltinTool([id, loader, exportName]) {
  try {
    const mod = await loader();
    const tool = mod[exportName];
    if (!tool || typeof tool !== 'object') {
      throw new Error(`Missing export ${exportName}`);
    }
    return tool;
  } catch (err) {
    console.error(`[tools] failed to load builtin tool ${id}:`, err);
    return unavailableTool(id, err);
  }
}

const builtinToolsPromise = Promise.all(builtinToolLoaders.map(loadBuiltinTool));

export async function loadBuiltinTools() {
  return builtinToolsPromise;
}
