import {
  DEFAULT_BLOCKED_GLOBS,
  DEFAULT_GLOB_LIMIT,
  MAX_GLOB_LIMIT,
  MAX_PATH_LENGTH,
  listWorkspaceFilesByGlob,
} from '../../workspace-files.mjs';
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
  id: 'glob',
  name: 'glob',
  title: 'Glob',
  description:
    'List workspace files matching a glob pattern. Use when the target path is unknown before grep or read_file. Examples: lib/**/*.mjs, **/package.json.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 10000,
  systemPrompt() {
    return [
      '# glob',
      '- List candidate paths when location is unknown. Prefer specific globs over **/*.',
    ].join('\n');
  },
  defaultConfig: {
    blockedGlobs: DEFAULT_BLOCKED_GLOBS,
    limit: DEFAULT_GLOB_LIMIT,
  },
  configSchema: {
    type: 'object',
    properties: {
      blockedGlobs: {
        type: 'array',
        description: 'Workspace-relative glob patterns excluded from listings.',
        items: { type: 'string' },
      },
      limit: {
        type: 'number',
        description: 'Default maximum files returned when limit is omitted.',
      },
    },
    additionalProperties: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, for example lib/tools/**/*.mjs.',
      },
      path: {
        type: 'string',
        description: 'Optional directory prefix to narrow candidates.',
      },
      query: {
        type: 'string',
        description: 'Optional substring filter on file path or name.',
      },
      limit: {
        type: 'number',
        description: 'Maximum files to return.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  validate(input) {
    requiredString(input.pattern, 'pattern', MAX_PATH_LENGTH);
    optionalString(input.path, 'path', MAX_PATH_LENGTH);
    optionalString(input.query, 'query', MAX_PATH_LENGTH);
    if (input.limit !== undefined && input.limit !== null && !Number.isInteger(Number(input.limit))) {
      throw new Error('limit must be an integer');
    }
  },

  async handler(input, { config: toolConfig = {} }) {
    const limit = clampInteger(
      input.limit ?? toolConfig.limit,
      DEFAULT_GLOB_LIMIT,
      1,
      MAX_GLOB_LIMIT,
    );

    return listWorkspaceFilesByGlob({
      pattern: input.pattern.trim(),
      path: input.path,
      query: input.query,
      limit,
      blockedGlobs: configuredBlockedGlobs(toolConfig),
    });
  },

  parseResult(output) {
    return {
      renderType: 'glob-list',
      data: {
        pattern: output.pattern,
        path: output.path,
        query: output.query,
        truncated: output.truncated,
        indexedCount: output.indexedCount,
        files: output.files,
      },
    };
  },
};
