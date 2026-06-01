import { getStreamModules } from './tool-ui-registry.js';

export function getStreamHelpers(modules) {
  const shell = modules.find(m => m.toolNames?.includes('shell_command'));
  return {
    markExistingShellCommandErrored: (tool, stream) => shell?.markExistingShellCommandErrored?.(tool, stream) ?? false,
  };
}

export function dispatchToolCall(evt, stream, effects, modules) {
  const helpers = getStreamHelpers(modules);
  for (const mod of modules) {
    mod.onToolCall?.(evt, stream, effects, helpers);
  }
}

export function dispatchToolDelta(evt, stream, effects, modules) {
  for (const mod of modules) {
    if (mod.onToolDelta?.(evt, stream, effects)) return true;
  }
  return false;
}

export function dispatchAskUserPending(evt, stream, effects, modules) {
  const askUser = modules.find(m => m.onAskUserPending);
  askUser?.onAskUserPending?.(evt, stream, effects);
}

export function dispatchToolResultTool(tool, stream, effects, modules, helpers) {
  const mergedHelpers = { ...getStreamHelpers(modules), ...helpers };
  for (const mod of modules) {
    if (mod.onToolResultTool?.(tool, stream, effects, mergedHelpers)) return true;
  }
  return false;
}

export async function loadStreamModules() {
  const { getStreamModules, loadToolUiRegistry } = await import('./tool-ui-registry.js');
  return getStreamModules();
}
