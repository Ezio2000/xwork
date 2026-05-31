import { access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverToolPackages } from './loader.mjs';
import { toolModuleUrl } from './package-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function inferRenderType(tool, uiMod) {
  if (uiMod?.renderType) return uiMod.renderType;
  if (typeof tool.parseResult === 'function') {
    try {
      const sample = tool.parseResult({});
      if (sample?.renderType) return sample.renderType;
    } catch {
      // ignore sample parse errors
    }
  }
  return null;
}

export async function buildToolUiManifest() {
  const packages = await discoverToolPackages();
  const sharedCssUrl = (await fileExists(join(__dirname, '_shared/styles/shell-toggle.css')))
    ? '/css/tools/_shared/shell-toggle.css'
    : null;

  const entries = [];
  for (const { slug, tool } of packages) {
    const basePath = join(__dirname, slug);
    const hasUi = await fileExists(join(basePath, 'ui.mjs'));
    const hasClient = await fileExists(join(basePath, 'client.mjs'));
    const hasStream = await fileExists(join(basePath, 'stream.mjs'));
    const hasCss = await fileExists(join(basePath, 'styles.css'));

    let uiMod = null;
    if (hasUi) {
      try {
        uiMod = await import(`./${slug}/ui.mjs`);
      } catch {
        uiMod = null;
      }
    }

    const renderType = inferRenderType(tool, uiMod);
    if (!hasUi && !renderType) continue;

    entries.push({
      toolId: tool.id,
      slug,
      renderType: renderType || uiMod?.renderType || null,
      uiUrl: hasUi ? toolModuleUrl(slug, 'ui.mjs') : null,
      clientUrl: hasClient ? toolModuleUrl(slug, 'client.mjs') : null,
      streamUrl: hasStream ? toolModuleUrl(slug, 'stream.mjs') : null,
      cssUrl: hasCss ? toolModuleUrl(slug, 'styles.css') : null,
    });
  }

  return {
    sharedCssUrl,
    tools: entries,
  };
}

export async function collectToolAssetRoutes() {
  const packages = await discoverToolPackages();
  const registrars = [];
  for (const { slug } of packages) {
    const assetsPath = join(__dirname, slug, 'assets.mjs');
    if (!(await fileExists(assetsPath))) continue;
    try {
      const mod = await import(`./${slug}/assets.mjs`);
      if (typeof mod.registerRoutes === 'function') {
        registrars.push(mod.registerRoutes);
      }
    } catch (err) {
      console.error(`[tools] failed to load assets for ${slug}:`, err);
    }
  }
  return registrars;
}

export function toolStaticFilePath(slug, filename) {
  const allowed = new Set(['ui.mjs', 'client.mjs', 'stream.mjs', 'styles.css']);
  if (!allowed.has(filename)) return null;
  if (slug === '_shared' && filename === 'styles.css') {
    return join(__dirname, '_shared/styles/shell-toggle.css');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  if (slug.startsWith('_')) return null;
  return join(__dirname, slug, filename);
}
