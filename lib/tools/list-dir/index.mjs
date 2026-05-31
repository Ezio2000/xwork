import {
  DEFAULT_BLOCKED_GLOBS,
  DEFAULT_LIST_DIR_DEPTH,
  DEFAULT_LIST_DIR_LIMIT,
  MAX_LIST_DIR_DEPTH,
  MAX_LIST_DIR_LIMIT,
  MAX_PATH_LENGTH,
  listWorkspaceDirectory,
} from '../../workspace-files.mjs';
import { workspaceExplorationSystemPrompt } from '../_shared/workspace-exploration-prompt.mjs';

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function optionalString(value, name, max) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function configuredBlockedGlobs(config) {
  const globs = config?.blockedGlobs ?? DEFAULT_BLOCKED_GLOBS;
  return Array.isArray(globs) ? globs.map(item => String(item).trim()).filter(Boolean) : DEFAULT_BLOCKED_GLOBS;
}

export const tool = {
  id: 'list_dir',
  name: 'list_dir',
  title: 'List Directory',
  description:
    'Browse workspace directory structure. Use when you need to see folders and files under a known path before grep or read_file. Supports depth, hidden entries, and name filtering.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 10000,
  systemPrompt() {
    return workspaceExplorationSystemPrompt();
  },
  defaultConfig: {
    blockedGlobs: DEFAULT_BLOCKED_GLOBS,
    depth: DEFAULT_LIST_DIR_DEPTH,
    limit: DEFAULT_LIST_DIR_LIMIT,
  },
  configSchema: {
    type: 'object',
    properties: {
      blockedGlobs: {
        type: 'array',
        description: 'Workspace-relative glob patterns excluded from listings.',
        items: { type: 'string' },
      },
      depth: {
        type: 'number',
        description: 'Default recursion depth when depth is omitted.',
      },
      limit: {
        type: 'number',
        description: 'Default maximum entries returned when limit is omitted.',
      },
    },
    additionalProperties: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative or absolute directory path. Defaults to workspace root.',
      },
      depth: {
        type: 'number',
        description: 'How many directory levels to expand. Default 2, maximum 5.',
      },
      include_hidden: {
        type: 'boolean',
        description: 'Include dotfiles and dot-directories. Defaults to false.',
      },
      query: {
        type: 'string',
        description: 'Optional case-insensitive substring filter on entry names or paths.',
      },
      limit: {
        type: 'number',
        description: 'Maximum entries to return.',
      },
    },
    additionalProperties: false,
  },

  validate(input) {
    optionalString(input.path, 'path', MAX_PATH_LENGTH);
    optionalString(input.query, 'query', MAX_PATH_LENGTH);
    if (input.depth !== undefined && input.depth !== null && !Number.isInteger(Number(input.depth))) {
      throw new Error('depth must be an integer');
    }
    if (input.limit !== undefined && input.limit !== null && !Number.isInteger(Number(input.limit))) {
      throw new Error('limit must be an integer');
    }
    if (input.include_hidden !== undefined && input.include_hidden !== null && typeof input.include_hidden !== 'boolean') {
      throw new Error('include_hidden must be a boolean');
    }
  },

  async handler(input, { config: toolConfig = {} }) {
    return listWorkspaceDirectory({
      path: input.path || '.',
      depth: clampInteger(
        input.depth ?? toolConfig.depth,
        DEFAULT_LIST_DIR_DEPTH,
        1,
        MAX_LIST_DIR_DEPTH,
      ),
      includeHidden: input.include_hidden === true,
      query: input.query,
      limit: clampInteger(
        input.limit ?? toolConfig.limit,
        DEFAULT_LIST_DIR_LIMIT,
        1,
        MAX_LIST_DIR_LIMIT,
      ),
      blockedGlobs: configuredBlockedGlobs(toolConfig),
    });
  },

  parseResult(output) {
    return {
      renderType: 'dir-list',
      data: {
        path: output.path,
        depth: output.depth,
        includeHidden: output.includeHidden,
        query: output.query,
        truncated: output.truncated,
        entryCount: output.entryCount,
        entries: output.entries,
      },
    };
  },
};
