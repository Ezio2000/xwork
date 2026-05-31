/**
 * Tool package contract — each tool folder under lib/tools/<slug>/ exports:
 *
 * index.mjs (required):
 *   export const tool = { id, name, adapter, handler?, parseResult?, ... }
 *
 *   Optional runtime-definition extension (lets a tool rewrite its own API-facing
 *   definition at request time WITHOUT the framework hardcoding the tool's name):
 *     tool.runtimeContext?: string[]
 *       — keys of runtime data the tool needs (e.g. ['expertAgents']). The registry
 *         collects only the declared keys and passes them to resolveDefinition.
 *     tool.resolveDefinition?(definition, runtimeContext) => definition
 *       — return a (possibly new) definition with description/inputSchema rewritten.
 *         IMPORTANT: the produced description string and inputSchema object flow into
 *         the upstream request body, so keep their bytes stable (same concat order,
 *         same key/enum order) to preserve provider prefix-cache hits.
 *
 * ui.mjs (optional):
 *   export const renderType = 'block-type'
 *   export const keepExpanded? = true
 *   export const defaultCollapsed? = true
 *   export function renderBlock(block, collapsed, ctx) {}
 *   export function installHandlers?(root, ctx) {}
 *
 * stream.mjs (optional):
 *   export function onToolDelta?(stream, tool, evt) {}
 *   export function onToolCall?(stream, tool, evt) {}
 *   export function onRunEvent?(stream, evt) {}
 *
 * client.mjs (optional): interactive client helpers for the browser
 *   export const toolId? = 'tool_id'
 *   export const toolIds? = ['tool_id']
 *   export function renderHeaderActions?(ctx) {}
 *   export function installHeaderActionHandlers?(root, ctx) {}
 *   export function renderConfigFields?(tool, ctx) {}
 *   export function editableConfig?(tool, config) {}
 *   export function normalizeConfigPayload?(tool, payload, form, ctx) {}
 * assets.mjs (optional): export function registerRoutes(router) {}
 * styles.css (optional): tool-specific styles
 * test.mjs (optional): node:test cases
 */

export const TOOL_PACKAGE_FILES = {
  index: 'index.mjs',
  ui: 'ui.mjs',
  stream: 'stream.mjs',
  client: 'client.mjs',
  assets: 'assets.mjs',
  styles: 'styles.css',
  test: 'test.mjs',
};

export const TOOL_PACKAGE_SKIP_DIRS = new Set(['_core', '_shared', 'builtin']);

export function toolFolderSlug(toolId) {
  return String(toolId || '').trim().replace(/_/g, '-');
}

export function toolModuleUrl(slug, file) {
  if (file === 'ui.mjs') return `/js/tools/${slug}/ui.mjs`;
  if (file === 'client.mjs') return `/js/tools/${slug}/client.mjs`;
  if (file === 'stream.mjs') return `/js/tools/${slug}/stream.mjs`;
  if (file === 'styles.css') return `/css/tools/${slug}/styles.css`;
  return null;
}
