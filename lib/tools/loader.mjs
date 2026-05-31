import { readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_PACKAGE_SKIP_DIRS } from './package-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverToolSlugs() {
  const entries = await readdir(__dirname, { withFileTypes: true });
  const slugs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (TOOL_PACKAGE_SKIP_DIRS.has(entry.name) || entry.name.startsWith('_')) continue;
    const indexPath = join(__dirname, entry.name, 'index.mjs');
    if (await fileExists(indexPath)) slugs.push(entry.name);
  }
  return slugs.sort();
}

async function loadToolFromSlug(slug) {
  try {
    const mod = await import(`./${slug}/index.mjs`);
    const tool = mod.tool ?? mod.default;
    if (!tool || typeof tool !== 'object') {
      throw new Error(`Missing export "tool" in lib/tools/${slug}/index.mjs`);
    }
    return { slug, tool };
  } catch (err) {
    console.error(`[tools] failed to load tool package ${slug}:`, err);
    const fallbackId = slug.replace(/-/g, '_');
    return { slug, tool: unavailableTool(fallbackId, err) };
  }
}

let toolsPromise = null;

export async function discoverToolPackages() {
  const slugs = await discoverToolSlugs();
  return Promise.all(slugs.map(loadToolFromSlug));
}

export async function loadTools() {
  if (!toolsPromise) {
    toolsPromise = discoverToolPackages().then(packages => packages.map(item => item.tool));
  }
  return toolsPromise;
}

export async function loadToolPackages() {
  if (!toolsPromise) {
    toolsPromise = discoverToolPackages().then(packages => packages.map(item => item.tool));
  }
  const slugs = await discoverToolSlugs();
  return discoverToolPackages();
}

export function resetToolsCacheForTests() {
  toolsPromise = null;
}

/** @deprecated use loadTools */
export async function loadBuiltinTools() {
  return loadTools();
}

export { discoverToolSlugs };
