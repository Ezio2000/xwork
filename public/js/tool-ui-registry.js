import { api } from './api-client.js';
import { state } from './state.js';

let registryPromise = null;
let blockRenderers = {};
let blockOptions = {};
let streamModules = [];
let clientModules = [];
let activeRenderCtx = null;
let loaded = false;

export function registerToolUiModules(uiModules, renderCtx, streams = [], clients = []) {
  const renderers = {};
  const options = {};
  activeRenderCtx = renderCtx;
  for (const mod of uiModules) {
    if (!mod?.renderType) continue;
    const optionTypes = [
      mod.renderType,
      ...(mod.aliasRenderTypes || []),
    ];
    const meta = {
      keepExpanded: mod.keepExpanded === true,
      defaultCollapsed: mod.defaultCollapsed !== undefined ? mod.defaultCollapsed === true : undefined,
    };
    for (const type of optionTypes) {
      if (type) options[type] = meta;
    }
    if (!mod?.renderBlock) continue;
    const renderer = (block, collapsed) => mod.renderBlock(block, collapsed, renderCtx);
    renderers[mod.renderType] = renderer;
    for (const alias of mod.aliasRenderTypes || []) renderers[alias] = renderer;
    for (const alt of mod.altRenderTypes || []) {
      if (!renderers[alt]) renderers[alt] = renderer;
    }
  }
  blockRenderers = renderers;
  blockOptions = options;
  streamModules = streams;
  clientModules = clients;
  loaded = true;
  registryPromise = Promise.resolve({ blockRenderers, blockOptions, streamModules, clientModules });
}

function ensureStylesheet(href) {
  if (!href || document.querySelector(`link[data-tool-css="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.toolCss = href;
  document.head.appendChild(link);
}

export function isToolUiRegistryLoaded() {
  return loaded;
}

export function getBlockRenderers() {
  return blockRenderers;
}

export function getBlockOptions() {
  return blockOptions;
}

export function getBlockOption(type) {
  return blockOptions[type] || {};
}

export function applyBlockOptions(block) {
  if (!block?.type) return block;
  const options = getBlockOption(block.type);
  if (options.keepExpanded) {
    block.collapsed = false;
    block.fixedOpen = true;
  } else if (options.defaultCollapsed !== undefined && block.collapsed === undefined) {
    block.collapsed = options.defaultCollapsed;
  }
  return block;
}

export function getStreamModules() {
  return streamModules;
}

export function getClientModules() {
  return clientModules;
}

export function getToolClientModule(toolId) {
  if (!toolId) return null;
  return clientModules.find(mod => {
    if (mod.toolId === toolId) return true;
    return Array.isArray(mod.toolIds) && mod.toolIds.includes(toolId);
  }) || null;
}

export async function loadToolUiRegistry(renderCtx) {
  if (registryPromise) return registryPromise;
  registryPromise = (async () => {
    activeRenderCtx = renderCtx;
    const manifest = await api('GET', '/api/v1/tools/ui-manifest');
    if (manifest.sharedCssUrl) ensureStylesheet(manifest.sharedCssUrl);
    const renderers = {};
    const options = {};
    const streams = [];
    const clients = [];

    for (const entry of manifest.tools || []) {
      if (entry.cssUrl) ensureStylesheet(entry.cssUrl);
      if (entry.uiUrl) {
        const mod = await import(entry.uiUrl);
        if (mod.renderType) {
          const meta = {
            keepExpanded: mod.keepExpanded === true,
            defaultCollapsed: mod.defaultCollapsed !== undefined ? mod.defaultCollapsed === true : undefined,
          };
          for (const type of [mod.renderType, ...(mod.aliasRenderTypes || [])]) {
            if (type) options[type] = meta;
          }
        }
        if (typeof mod.renderBlock === 'function') {
          const renderer = (block, collapsed) => mod.renderBlock(block, collapsed, renderCtx);
          if (mod.renderType) renderers[mod.renderType] = renderer;
          for (const alias of mod.aliasRenderTypes || []) renderers[alias] = renderer;
          for (const alt of mod.altRenderTypes || []) {
            if (!renderers[alt]) renderers[alt] = renderer;
          }
        }
      }
      if (entry.streamUrl) {
        streams.push(await import(entry.streamUrl));
      }
      if (entry.clientUrl) {
        clients.push(await import(entry.clientUrl));
      }
    }

    blockRenderers = renderers;
    blockOptions = options;
    streamModules = streams;
    clientModules = clients;
    loaded = true;
    return { blockRenderers, blockOptions, streamModules, clientModules };
  })();
  return registryPromise;
}

export async function installToolEventHandlers(root, renderCtx) {
  await loadToolUiRegistry(renderCtx);
  for (const mod of clientModules) {
    mod.installHandlers?.(root, renderCtx);
  }
  for (const mod of streamModules) {
    mod.installHandlers?.(root, renderCtx);
  }
}

export function renderToolHeaderActions(ctx = {}) {
  const renderCtx = { api, state, ...(activeRenderCtx || {}), ...ctx };
  return clientModules
    .map(mod => typeof mod.renderHeaderActions === 'function' ? mod.renderHeaderActions(renderCtx) : '')
    .filter(Boolean)
    .join('');
}

export function installToolHeaderActionHandlers(root, ctx = {}) {
  if (!root) return;
  const renderCtx = { api, state, ...(activeRenderCtx || {}), ...ctx };
  for (const mod of clientModules) {
    mod.installHeaderActionHandlers?.(root, renderCtx);
  }
}

export function renderToolConfigFields(tool, ctx = {}) {
  const mod = getToolClientModule(tool?.id);
  if (typeof mod?.renderConfigFields !== 'function') return '';
  const renderCtx = { api, state, ...(activeRenderCtx || {}), ...ctx };
  return mod.renderConfigFields(tool, renderCtx) || '';
}

export function editableToolConfig(tool, config = tool?.config || {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const out = { ...source };
  const mod = getToolClientModule(tool?.id);
  if (typeof mod?.editableConfig === 'function') {
    return mod.editableConfig(tool, out) || out;
  }
  for (const key of mod?.hiddenConfigKeys || []) {
    delete out[key];
  }
  return out;
}

export function normalizeToolConfigPayload(tool, payload, form, ctx = {}) {
  const mod = getToolClientModule(tool?.id);
  if (typeof mod?.normalizeConfigPayload !== 'function') return payload;
  const renderCtx = { api, state, ...(activeRenderCtx || {}), ...ctx };
  return mod.normalizeConfigPayload(tool, payload, form, renderCtx) || payload;
}

export function applyToolConfigExample(tool, config, card, ctx = {}) {
  const mod = getToolClientModule(tool?.id);
  if (typeof mod?.applyConfigExample !== 'function') return false;
  const renderCtx = { api, state, ...(activeRenderCtx || {}), ...ctx };
  return mod.applyConfigExample(tool, config, card, renderCtx) === true;
}
