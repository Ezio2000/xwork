import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// xwork 自身的安装目录（package.json 所在）。永远固定，用于 xwork 自身状态：
// data/conversations、data/tool-runs.json、data/browser-screenshots、config.json 等。
export const PROJECT_ROOT = resolve(__dirname, '..');

let activeRoot = PROJECT_ROOT;
let activeLabel = null;
const listeners = new Set();

export function getProjectRoot() {
  return PROJECT_ROOT;
}

export function getWorkspaceRoot() {
  return activeRoot;
}

export function getWorkspaceInfo() {
  return {
    root: activeRoot,
    label: activeLabel,
    isDefault: activeRoot === PROJECT_ROOT,
    projectRoot: PROJECT_ROOT,
  };
}

export function setWorkspaceRoot(absolutePath, { label = null } = {}) {
  const target = absolutePath ? resolve(absolutePath) : PROJECT_ROOT;
  const nextLabel = label || null;
  if (target === activeRoot && nextLabel === activeLabel) return getWorkspaceInfo();
  activeRoot = target;
  activeLabel = nextLabel;
  const info = getWorkspaceInfo();
  for (const fn of listeners) {
    try { fn(info); } catch {}
  }
  return info;
}

export function onWorkspaceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 同步校验：返回 { absolutePath: string | null, isDefault }。null = 使用默认。
export function validateWorkspaceCandidate(input) {
  if (input === undefined || input === null || input === '') {
    return { absolutePath: null, isDefault: true };
  }
  if (typeof input !== 'string') throw new Error('workspace root must be a string');
  const trimmed = input.trim();
  if (!trimmed) return { absolutePath: null, isDefault: true };
  if (!isAbsolute(trimmed)) throw new Error('workspace root must be an absolute path');
  if (trimmed.length > 1000) throw new Error('workspace root is too long');
  const resolved = resolve(trimmed);
  if (!existsSync(resolved)) throw new Error(`workspace root does not exist: ${resolved}`);
  let stat;
  try {
    stat = statSync(resolved);
  } catch (err) {
    throw new Error(`workspace root is not accessible: ${err.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`workspace root must be a directory: ${resolved}`);
  return { absolutePath: resolved, isDefault: resolved === PROJECT_ROOT };
}

export function isInsideWorkspace(absolutePath) {
  if (!absolutePath) return false;
  const resolved = resolve(absolutePath);
  if (resolved === activeRoot) return true;
  return resolved.startsWith(activeRoot + sep);
}
