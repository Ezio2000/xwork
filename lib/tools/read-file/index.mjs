import {
  DEFAULT_BLOCKED_GLOBS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  MAX_MAX_BYTES,
  MAX_MAX_LINES,
  MAX_PATH_LENGTH,
  MIN_MAX_LINES,
  readWorkspaceTextFile,
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

function configuredValue(config, key, fallback) {
  const value = config?.[key];
  return value === undefined ? fallback : value;
}

function configuredBlockedGlobs(config) {
  const globs = configuredValue(config, 'blockedGlobs', DEFAULT_BLOCKED_GLOBS);
  return Array.isArray(globs) ? globs.map(item => String(item).trim()).filter(Boolean) : DEFAULT_BLOCKED_GLOBS;
}

const SUPPORTED_ENCODINGS = new Set(['utf-8', 'utf8', 'gb18030', 'gbk']);

export const tool = {
  id: 'read_file',
  name: 'read_file',
  title: 'Read File',
  description:
    'Read a narrow slice of a known workspace text file. Use after glob/grep locate the path, or when the user @mentions a file. Supports UTF-8 and GB18030. Use offset and limit; do not use this to search across the repo.',
  category: 'system',
  adapter: 'builtin',
  version: '1.1.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 10000,
  systemPrompt() {
    return [
      '# read_file',
      '- Use for known paths (including user @mentions) or narrow regions after grep.',
      '- Default to small limit/offset windows. If truncated, continue with a higher offset.',
    ].join('\n');
  },
  defaultConfig: {
    blockedGlobs: DEFAULT_BLOCKED_GLOBS,
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  },
  configSchema: {
    type: 'object',
    properties: {
      blockedGlobs: {
        type: 'array',
        description: 'Workspace-relative glob patterns that cannot be read.',
        items: { type: 'string' },
      },
      maxBytes: {
        type: 'number',
        description: 'Maximum file size in bytes that can be read in one call.',
      },
      maxLines: {
        type: 'number',
        description: 'Maximum number of lines returned when limit is omitted.',
      },
    },
    additionalProperties: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative or absolute path to the file.',
      },
      offset: {
        type: 'number',
        description: '1-based starting line number. Defaults to 1.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to return. Defaults to the tool maxLines config.',
      },
      encoding: {
        type: 'string',
        description: 'Text encoding. Supported: utf-8, gb18030.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },

  validate(input) {
    requiredString(input.path, 'path', MAX_PATH_LENGTH);
    if (input.offset !== undefined && input.offset !== null && !Number.isInteger(Number(input.offset))) {
      throw new Error('offset must be an integer');
    }
    if (input.limit !== undefined && input.limit !== null && !Number.isInteger(Number(input.limit))) {
      throw new Error('limit must be an integer');
    }
    if (input.encoding !== undefined && input.encoding !== null) {
      const lower = String(input.encoding).toLowerCase();
      if (!SUPPORTED_ENCODINGS.has(lower)) {
        throw new Error('encoding must be utf-8 or gb18030');
      }
    }
  },

  async handler(input, { config: toolConfig = {} }) {
    const maxBytes = clampInteger(toolConfig.maxBytes, DEFAULT_MAX_BYTES, 1024, MAX_MAX_BYTES);
    const maxLines = clampInteger(toolConfig.maxLines, DEFAULT_MAX_LINES, MIN_MAX_LINES, MAX_MAX_LINES);
    const blockedGlobs = configuredBlockedGlobs(toolConfig);

    return readWorkspaceTextFile(input.path, {
      blockedGlobs,
      maxBytes,
      maxLines,
      offset: input.offset === undefined || input.offset === null ? 1 : Number(input.offset),
      limit: input.limit === undefined || input.limit === null ? undefined : Number(input.limit),
      encoding: input.encoding,
    });
  },

  parseResult(output) {
    return {
      renderType: 'file-snippet',
      data: {
        path: output.path,
        encoding: output.encoding,
        size: output.size,
        totalLines: output.totalLines,
        startLine: output.startLine,
        endLine: output.endLine,
        truncated: output.truncated,
        contentPreview: output.content.slice(0, 4000),
        content: output.content,
      },
    };
  },
};
