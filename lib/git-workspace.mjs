import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { getWorkspaceRoot, isInsideWorkspace } from './workspace-root.mjs';
import { MAX_PATH_LENGTH } from './workspace-files.mjs';

export const DEFAULT_GIT_MAX_OUTPUT_CHARS = 40_000;
export const MAX_GIT_MAX_OUTPUT_CHARS = 100_000;
export const DEFAULT_GIT_TIMEOUT_MS = 20_000;
export const MAX_GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_GIT_LOG_COUNT = 20;
export const MAX_GIT_LOG_COUNT = 100;

const GIT_ACTIONS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'remote',
  'blame',
  'stash_list',
  'reflog',
  'tag',
]);

const REF_PATTERN = /^[\w./\-~^@{}]+$/;
const TAG_PATTERN = /^[\w./\-*?[\]]+$/;

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function requiredString(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${name} is too long`);
  return trimmed;
}

function optionalString(value, name, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
  return value.trim();
}

function optionalStringArray(value, name, maxItems = 20) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > maxItems) throw new Error(`${name} must contain at most ${maxItems} items`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${name}[${index}] must be a non-empty string`);
    if (item.length > MAX_PATH_LENGTH) throw new Error(`${name}[${index}] is too long`);
    return item.trim();
  });
}

function validateRef(ref, { name = 'ref', allowHead = true } = {}) {
  const trimmed = requiredString(ref, name, 200);
  if (allowHead && trimmed === 'HEAD') return trimmed;
  if (!REF_PATTERN.test(trimmed)) throw new Error(`${name} contains invalid characters`);
  return trimmed;
}

function validateTagPattern(pattern) {
  if (pattern === undefined || pattern === null || pattern === '') return null;
  const trimmed = optionalString(pattern, 'pattern', 200);
  if (!trimmed) return null;
  if (!TAG_PATTERN.test(trimmed)) throw new Error('pattern contains invalid characters');
  return trimmed;
}

function resolveGitCwd(cwd) {
  const root = getWorkspaceRoot();
  if (cwd === undefined || cwd === null || cwd === '') return root;
  requiredString(cwd, 'cwd', MAX_PATH_LENGTH);
  const resolved = isAbsolute(cwd) ? resolve(cwd) : resolve(root, cwd);
  if (!isInsideWorkspace(resolved)) throw new Error('cwd must stay inside the workspace root');
  if (!existsSync(resolved)) throw new Error('cwd does not exist');
  return resolved;
}

function assertGitRepository(cwd) {
  if (!existsSync(join(cwd, '.git'))) {
    throw new Error('workspace is not a git repository');
  }
}

function resolveGitPaths(paths, cwd) {
  const root = getWorkspaceRoot();
  return paths.map((item) => {
    if (item === '--' || item.startsWith('-')) {
      throw new Error('paths must not look like git options');
    }
    const resolved = isAbsolute(item) ? resolve(item) : resolve(cwd, item);
    if (!isInsideWorkspace(resolved)) {
      throw new Error(`path must stay inside the workspace root: ${item}`);
    }
    if (!existsSync(resolved)) {
      throw new Error(`path does not exist: ${item}`);
    }
    const relativePath = isAbsolute(item)
      ? resolved.slice(root.length + 1).split('\\').join('/')
      : item.split('\\').join('/');
    return relativePath;
  });
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

function runGit(args, { cwd, timeoutMs, maxOutputChars }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`git command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '');
      const truncatedResult = truncateText(combined, maxOutputChars);
      resolvePromise({
        exitCode: code ?? 1,
        output: truncatedResult.text,
        truncated: truncatedResult.truncated,
        stdout,
        stderr,
      });
    });
  });
}

function buildStatusArgs(input) {
  return ['status', '--branch', '--short'];
}

function buildDiffArgs(input, cwd) {
  const args = ['diff', '--no-color'];
  const context = clampInteger(input.context, 3, 0, 5);
  if (context > 0) args.push(`-U${context}`);

  if (input.statOnly === true) {
    args.push('--stat');
  } else if (input.statOnly === false) {
    // default patch output
  } else {
    args.push('--stat', '--patch');
  }

  if (input.staged === true) args.push('--cached');

  const baseRef = optionalString(input.baseRef, 'baseRef', 200);
  const ref = optionalString(input.ref, 'ref', 200);
  if (baseRef) validateRef(baseRef, { name: 'baseRef' });
  if (ref) validateRef(ref, { name: 'ref' });

  if (baseRef && ref) {
    args.push(baseRef, ref);
  } else if (ref) {
    args.push(ref);
  }

  const paths = optionalStringArray(input.paths, 'paths');
  if (paths.length) {
    args.push('--', ...resolveGitPaths(paths, cwd));
  }

  return args;
}

function buildLogArgs(input, cwd) {
  const maxCount = clampInteger(input.maxCount, DEFAULT_GIT_LOG_COUNT, 1, MAX_GIT_LOG_COUNT);
  const args = [
    'log',
    '--no-color',
    '--decorate',
    `--max-count=${maxCount}`,
  ];

  const format = input.format === 'medium' ? 'medium' : 'oneline';
  if (format === 'medium') {
    args.push('--pretty=format:%h %d%nAuthor: %an <%ae>%nDate:   %ad%n%n    %s%n');
    args.push('--date=iso-strict');
  } else {
    args.push('--pretty=format:%h %d %s');
  }

  const since = optionalString(input.since, 'since', 100);
  if (since) args.push(`--since=${since}`);

  const grep = optionalString(input.grep, 'grep', 200);
  if (grep) args.push('--grep', grep, '--regexp-ignore-case');

  const author = optionalString(input.author, 'author', 200);
  if (author) args.push(`--author=${author}`);

  const paths = optionalStringArray(input.paths, 'paths');
  if (paths.length) {
    args.push('--', ...resolveGitPaths(paths, cwd));
  }

  return args;
}

function buildShowArgs(input) {
  const ref = validateRef(input.ref || 'HEAD', { name: 'ref' });
  const args = ['show', '--no-color', ref];
  if (input.statOnly === true) {
    args.push('--stat');
  } else if (input.patch === false) {
    args.push('--stat', '--summary');
  } else {
    args.push('--stat', '--patch');
  }
  return args;
}

function buildBranchArgs(input) {
  const args = ['branch', '--no-color'];
  if (input.all === true) args.push('-a');
  if (input.merged === true) args.push('--merged');
  if (input.noMerged === true) args.push('--no-merged');
  const contains = optionalString(input.contains, 'contains', 200);
  if (contains) {
    validateRef(contains, { name: 'contains' });
    args.push('--contains', contains);
  }
  return args;
}

function buildRemoteArgs() {
  return ['remote', '-v'];
}

function buildBlameArgs(input, cwd) {
  const path = requiredString(input.path, 'path', MAX_PATH_LENGTH);
  const [relativePath] = resolveGitPaths([path], cwd);
  const args = ['blame', '--line-porcelain', '--', relativePath];

  const startLine = input.startLine === undefined || input.startLine === null
    ? null
    : clampInteger(input.startLine, 1, 1, 100_000);
  const endLine = input.endLine === undefined || input.endLine === null
    ? null
    : clampInteger(input.endLine, startLine || 1, 1, 100_000);

  if (startLine !== null && endLine !== null) {
    args.splice(1, 0, `-L${startLine},${endLine}`);
  } else if (startLine !== null) {
    args.splice(1, 0, `-L${startLine},+20`);
  }

  return args;
}

function buildStashListArgs() {
  return ['stash', 'list'];
}

function buildReflogArgs(input) {
  const maxCount = clampInteger(input.maxCount, DEFAULT_GIT_LOG_COUNT, 1, MAX_GIT_LOG_COUNT);
  return ['reflog', '--no-color', `--max-count=${maxCount}`];
}

function buildTagArgs(input) {
  const args = ['tag', '--list'];
  const pattern = validateTagPattern(input.pattern);
  if (pattern) args.push(pattern);
  return args;
}

function summarizeStatus(output) {
  const lines = output.split('\n').filter(Boolean);
  const branchLine = lines.find(line => line.startsWith('## ')) || '';
  const branchMatch = branchLine.match(/^## ([^\s.]+)(?:\.\.\.([^\s]+))?/);
  const fileLines = lines.filter(line => !line.startsWith('## '));
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of fileLines) {
    const code = line.slice(0, 2);
    if (code === '??') untracked += 1;
    if (code[0] && code[0] !== '?' && code[0] !== ' ') staged += 1;
    if (code[1] && code[1] !== '?') unstaged += 1;
  }

  return {
    branch: branchMatch?.[1] || null,
    upstream: branchMatch?.[2] || null,
    stagedCount: staged,
    unstagedCount: unstaged,
    untrackedCount: untracked,
    clean: fileLines.length === 0,
  };
}

function summarizeLog(output) {
  const commits = output.split('\n').filter(Boolean);
  return {
    commitCount: commits.length,
    commits: commits.slice(0, 5).map(line => line.trim()),
  };
}

function summarizeBranch(output) {
  const branches = output.split('\n').filter(Boolean);
  const current = branches.find(line => line.startsWith('* '))?.slice(2).trim() || null;
  return {
    branchCount: branches.length,
    current,
  };
}

function buildSummary(action, output) {
  switch (action) {
    case 'status':
      return summarizeStatus(output);
    case 'log':
    case 'reflog':
    case 'stash_list':
      return summarizeLog(output);
    case 'branch':
      return summarizeBranch(output);
    default:
      return null;
  }
}

function buildArgs(action, input, cwd) {
  switch (action) {
    case 'status':
      return buildStatusArgs(input);
    case 'diff':
      return buildDiffArgs(input, cwd);
    case 'log':
      return buildLogArgs(input, cwd);
    case 'show':
      return buildShowArgs(input);
    case 'branch':
      return buildBranchArgs(input);
    case 'remote':
      return buildRemoteArgs();
    case 'blame':
      return buildBlameArgs(input, cwd);
    case 'stash_list':
      return buildStashListArgs();
    case 'reflog':
      return buildReflogArgs(input);
    case 'tag':
      return buildTagArgs(input);
    default:
      throw new Error(`Unsupported git action: ${action}`);
  }
}

export function validateGitInput(input = {}) {
  const action = requiredString(input.action, 'action', 50);
  if (!GIT_ACTIONS.has(action)) {
    throw new Error(`action must be one of: ${[...GIT_ACTIONS].join(' | ')}`);
  }

  if (action === 'blame') {
    requiredString(input.path, 'path', MAX_PATH_LENGTH);
  }

  if (input.context !== undefined && input.context !== null && !Number.isInteger(Number(input.context))) {
    throw new Error('context must be an integer');
  }
  if (input.maxCount !== undefined && input.maxCount !== null && !Number.isInteger(Number(input.maxCount))) {
    throw new Error('maxCount must be an integer');
  }
  if (input.startLine !== undefined && input.startLine !== null && !Number.isInteger(Number(input.startLine))) {
    throw new Error('startLine must be an integer');
  }
  if (input.endLine !== undefined && input.endLine !== null && !Number.isInteger(Number(input.endLine))) {
    throw new Error('endLine must be an integer');
  }

  return action;
}

export async function runGitAction(input = {}, {
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  maxOutputChars = DEFAULT_GIT_MAX_OUTPUT_CHARS,
} = {}) {
  const action = validateGitInput(input);
  const cwd = resolveGitCwd(input.cwd);
  assertGitRepository(cwd);

  const args = buildArgs(action, input, cwd);
  const result = await runGit(args, {
    cwd,
    timeoutMs,
    maxOutputChars,
  });

  const summary = buildSummary(action, result.output);
  const relativeCwd = cwd === getWorkspaceRoot()
    ? '.'
    : cwd.slice(getWorkspaceRoot().length + 1).split('\\').join('/');

  return {
    action,
    cwd: relativeCwd,
    command: `git ${args.join(' ')}`,
    exitCode: result.exitCode,
    truncated: result.truncated,
    output: result.output,
    summary,
  };
}

export { GIT_ACTIONS };
