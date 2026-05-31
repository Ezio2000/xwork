import {
  DEFAULT_BLOCKED_GLOBS,
  DEFAULT_GREP_CONTEXT,
  DEFAULT_GREP_HEAD_LIMIT,
  MAX_GREP_CONTEXT,
  MAX_GREP_HEAD_LIMIT,
  MAX_GREP_PATTERN_LENGTH,
  MAX_PATH_LENGTH,
  grepWorkspaceFiles,
} from '../../workspace-files.mjs';
import { workspaceExplorationSystemPrompt } from '../_shared/workspace-exploration-prompt.mjs';

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function requiredString(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} is too long`);
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
  id: 'grep',
  name: 'grep',
  title: 'Grep',
  description:
    'Search workspace text files for a regex or literal string. Returns matching path:line entries with optional context. Use before read_file when the line number is unknown. Narrow with path or glob.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 30000,
  systemPrompt() {
    return workspaceExplorationSystemPrompt();
  },
  defaultConfig: {
    blockedGlobs: DEFAULT_BLOCKED_GLOBS,
    headLimit: DEFAULT_GREP_HEAD_LIMIT,
    context: DEFAULT_GREP_CONTEXT,
  },
  configSchema: {
    type: 'object',
    properties: {
      blockedGlobs: {
        type: 'array',
        description: 'Workspace-relative glob patterns excluded from search.',
        items: { type: 'string' },
      },
      headLimit: {
        type: 'number',
        description: 'Default maximum matches returned when head_limit is omitted.',
      },
      context: {
        type: 'number',
        description: 'Default context lines around each match.',
      },
    },
    additionalProperties: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex or literal text to search for.',
      },
      path: {
        type: 'string',
        description: 'Optional file or directory prefix to narrow the search (workspace-relative).',
      },
      glob: {
        type: 'string',
        description: 'Optional glob filter, for example lib/**/*.mjs.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case-insensitive search. Defaults to false.',
      },
      context: {
        type: 'number',
        description: 'Lines of context before and after each match. Defaults to tool config.',
      },
      head_limit: {
        type: 'number',
        description: 'Maximum matches to return. Defaults to tool config.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  validate(input) {
    requiredString(input.pattern, 'pattern', MAX_GREP_PATTERN_LENGTH);
    optionalString(input.path, 'path', MAX_PATH_LENGTH);
    optionalString(input.glob, 'glob', MAX_PATH_LENGTH);
    if (input.context !== undefined && input.context !== null && !Number.isInteger(Number(input.context))) {
      throw new Error('context must be an integer');
    }
    if (input.head_limit !== undefined && input.head_limit !== null && !Number.isInteger(Number(input.head_limit))) {
      throw new Error('head_limit must be an integer');
    }
  },

  async handler(input, { config: toolConfig = {} }) {
    const headLimit = clampInteger(
      input.head_limit ?? toolConfig.headLimit,
      DEFAULT_GREP_HEAD_LIMIT,
      1,
      MAX_GREP_HEAD_LIMIT,
    );
    const context = clampInteger(
      input.context ?? toolConfig.context,
      DEFAULT_GREP_CONTEXT,
      0,
      MAX_GREP_CONTEXT,
    );

    return grepWorkspaceFiles({
      pattern: input.pattern.trim(),
      path: input.path,
      glob: input.glob,
      caseInsensitive: Boolean(input.case_insensitive),
      context,
      headLimit,
      blockedGlobs: configuredBlockedGlobs(toolConfig),
    });
  },

  parseResult(output) {
    return {
      renderType: 'grep-matches',
      data: {
        pattern: output.pattern,
        path: output.path,
        glob: output.glob,
        matchCount: output.matchCount,
        truncated: output.truncated,
        scannedFiles: output.scannedFiles,
        skippedLargeFiles: output.skippedLargeFiles,
        matches: output.matches,
      },
    };
  },
};
