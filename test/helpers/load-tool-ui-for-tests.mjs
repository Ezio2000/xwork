import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(__dirname, '../../lib/tools');

export async function loadToolUiForTests() {
  const { buildToolRenderCtx } = await import('../../public/js/renderers.js');
  const { registerToolUiModules } = await import('../../public/js/tool-ui-registry.js');

  const entries = await readdir(toolsDir, { withFileTypes: true });
  const uiModules = [];
  const streamModules = [];
  const clientModules = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const base = join(toolsDir, entry.name);
    try {
      uiModules.push(await import(pathToFileURL(join(base, 'ui.mjs')).href));
    } catch {
      // optional ui
    }
    try {
      streamModules.push(await import(pathToFileURL(join(base, 'stream.mjs')).href));
    } catch {
      // optional stream
    }
    try {
      clientModules.push(await import(pathToFileURL(join(base, 'client.mjs')).href));
    } catch {
      // optional client
    }
  }

  const renderCtx = buildToolRenderCtx();
  registerToolUiModules(uiModules, renderCtx, streamModules, clientModules);
  return { renderCtx, uiModules, streamModules, clientModules };
}
