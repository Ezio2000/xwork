import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { getWorkspaceRoot } from '../../workspace-root.mjs';
import {
  DEFAULT_BLOCKED_GLOBS,
  getPathPolicyFailure,
  invalidateWorkspaceFileIndex,
  normalizeEncoding,
} from '../../workspace-files.mjs';

const MAX_PATH_LENGTH = 1000;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_OLD_STRING_LENGTH = 200_000;
const MAX_NEW_STRING_LENGTH = 200_000;
const MAX_PREVIEW_CHARS = 2000;
const SUPPORTED_ENCODINGS = new Set(['utf-8', 'utf8']);
const MODES = new Set(['overwrite', 'append', 'str_replace']);

function requiredString(value, name, max) {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  if (!value.length) throw new Error(`${name} must not be empty`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function optionalString(value, name, max) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function configuredBlockedGlobs(config) {
  const globs = config?.blockedGlobs ?? DEFAULT_BLOCKED_GLOBS;
  return Array.isArray(globs) ? globs.map(item => String(item).trim()).filter(Boolean) : DEFAULT_BLOCKED_GLOBS;
}

function resolveWritePath(input) {
  requiredString(input, 'path', MAX_PATH_LENGTH);
  const root = getWorkspaceRoot();
  const resolved = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('path must stay inside the workspace root');
  }
  return { absolutePath: resolved, relativePath: rel.split('\\').join('/') };
}

function ensureNotBlocked(relativePath, fileName, blockedGlobs) {
  const failure = getPathPolicyFailure(relativePath, fileName, { blockedGlobs });
  if (failure) {
    const err = new Error(failure.message);
    err.code = failure.code;
    throw err;
  }
}

function countLines(text) {
  if (!text) return 0;
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized) return 0;
  return normalized.split('\n').length;
}

function previewOf(text, max = MAX_PREVIEW_CHARS) {
  const value = String(text ?? '');
  if (value.length <= max) return { preview: value, truncated: false };
  return { preview: `${value.slice(0, max)}\n... [truncated ${value.length - max} chars]`, truncated: true };
}

export const writeFileTool = {
  id: 'write_file',
  name: 'write_file',
  title: 'Write File',
  description:
    'Create, overwrite, append, or surgically edit a workspace text file. Modes: overwrite | append | str_replace. ' +
    'str_replace requires the file to exist and old_string to occur exactly once. Paths must stay inside the workspace root; ' +
    'env files, secret keys, and binary extensions are refused.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'high',
  defaultEnabled: false,
  timeoutMs: 10000,
  systemPrompt() {
    return [
      '# write_file',
      '- Pick the smallest applicable mode: str_replace for surgical edits, overwrite only when replacing the whole file, append for log/journal-style additions.',
      '- str_replace requires old_string to match a unique, contiguous slice of the existing file. Include enough surrounding context to make the match unambiguous.',
      '- Prefer reading the file with read_file before str_replace to confirm the exact bytes you intend to replace.',
      '- Never use write_file to add hand-written placeholder comments. Comments should explain non-obvious intent only.',
      '- Refuse to write to .env, key material, or binary extensions; choose a different target path instead.',
    ].join('\n');
  },
  defaultConfig: {
    blockedGlobs: DEFAULT_BLOCKED_GLOBS,
    maxBytes: MAX_CONTENT_BYTES,
  },
  configSchema: {
    type: 'object',
    properties: {
      blockedGlobs: {
        type: 'array',
        description: 'Workspace-relative glob patterns that cannot be written.',
        items: { type: 'string' },
      },
      maxBytes: {
        type: 'number',
        description: 'Maximum bytes that may be written in a single call.',
      },
    },
    additionalProperties: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative or absolute path inside the workspace root.',
      },
      mode: {
        type: 'string',
        description: 'overwrite (default): replace the entire file. append: add to the end. str_replace: surgical edit.',
        enum: ['overwrite', 'append', 'str_replace'],
      },
      content: {
        type: 'string',
        description: 'New file content for overwrite or text to append. Required when mode is overwrite or append.',
      },
      old_string: {
        type: 'string',
        description: 'For mode=str_replace: the exact text to replace. Must occur exactly once in the file.',
      },
      new_string: {
        type: 'string',
        description: 'For mode=str_replace: the replacement text. Empty string deletes the matched block.',
      },
      encoding: {
        type: 'string',
        description: 'Text encoding. Only utf-8 is supported for writing. Defaults to utf-8.',
        enum: ['utf-8'],
      },
      createDirs: {
        type: 'boolean',
        description: 'When true (default), create missing parent directories for overwrite mode.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },

  validate(input) {
    requiredString(input.path, 'path', MAX_PATH_LENGTH);
    if (input.mode !== undefined && !MODES.has(String(input.mode))) {
      throw new Error('mode must be one of overwrite | append | str_replace');
    }
    const mode = String(input.mode || 'overwrite');
    if (mode === 'overwrite' || mode === 'append') {
      if (typeof input.content !== 'string') throw new Error('content is required for overwrite/append');
      if (input.content.length > MAX_NEW_STRING_LENGTH) throw new Error('content is too long');
    }
    if (mode === 'str_replace') {
      requiredString(input.old_string, 'old_string', MAX_OLD_STRING_LENGTH);
      if (input.new_string === undefined || input.new_string === null) {
        throw new Error('new_string is required for str_replace');
      }
      if (typeof input.new_string !== 'string') throw new Error('new_string must be a string');
      if (input.new_string.length > MAX_NEW_STRING_LENGTH) throw new Error('new_string is too long');
      if (input.old_string === input.new_string) {
        throw new Error('old_string and new_string must differ');
      }
    }
    if (input.encoding !== undefined && input.encoding !== null) {
      const lower = String(input.encoding).toLowerCase();
      if (!SUPPORTED_ENCODINGS.has(lower)) {
        throw new Error('encoding must be utf-8');
      }
    }
    optionalString(input.encoding, 'encoding', 32);
  },

  async handler(input, { config: toolConfig = {} }) {
    const mode = String(input.mode || 'overwrite');
    const encoding = normalizeEncoding(input.encoding);
    const maxBytes = Number.isFinite(Number(toolConfig.maxBytes)) ? Number(toolConfig.maxBytes) : MAX_CONTENT_BYTES;
    const blockedGlobs = configuredBlockedGlobs(toolConfig);

    const { absolutePath, relativePath } = resolveWritePath(input.path);
    const fileName = relativePath.split('/').pop() || relativePath;
    ensureNotBlocked(relativePath, fileName, blockedGlobs);

    const fileExists = existsSync(absolutePath);
    let beforeText = '';
    let beforeSize = 0;
    if (fileExists) {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) throw new Error('path must be a file, not a directory');
      beforeSize = fileStat.size;
      if (mode !== 'overwrite' || fileStat.size <= maxBytes) {
        try {
          beforeText = await readFile(absolutePath, 'utf8');
        } catch {
          beforeText = '';
        }
      }
    } else if (mode === 'append' || mode === 'str_replace') {
      throw new Error(`File does not exist: ${relativePath}`);
    }

    let nextText;
    let replacements = 0;
    if (mode === 'overwrite') {
      nextText = String(input.content || '');
    } else if (mode === 'append') {
      const addition = String(input.content || '');
      if (beforeText.length && !beforeText.endsWith('\n') && !addition.startsWith('\n')) {
        nextText = `${beforeText}\n${addition}`;
      } else {
        nextText = `${beforeText}${addition}`;
      }
    } else {
      const oldStr = String(input.old_string);
      const newStr = String(input.new_string);
      const firstIndex = beforeText.indexOf(oldStr);
      if (firstIndex === -1) {
        throw new Error('old_string was not found in the file');
      }
      const secondIndex = beforeText.indexOf(oldStr, firstIndex + oldStr.length);
      if (secondIndex !== -1) {
        throw new Error('old_string occurs more than once; include more context to make it unique');
      }
      nextText = beforeText.slice(0, firstIndex) + newStr + beforeText.slice(firstIndex + oldStr.length);
      replacements = 1;
    }

    const nextBuffer = new TextEncoder().encode(nextText);
    if (nextBuffer.byteLength > maxBytes) {
      throw new Error(`resulting file size ${nextBuffer.byteLength} bytes exceeds maxBytes (${maxBytes})`);
    }

    if (mode === 'overwrite' && input.createDirs !== false) {
      const dir = dirname(absolutePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }

    await writeFile(absolutePath, nextText, 'utf8');
    invalidateWorkspaceFileIndex();

    const afterStat = await stat(absolutePath);
    const beforeLines = countLines(beforeText);
    const afterLines = countLines(nextText);
    const { preview } = previewOf(nextText);

    return {
      path: relativePath,
      mode,
      encoding,
      created: !fileExists,
      replacements,
      beforeSize,
      afterSize: afterStat.size,
      beforeLines,
      afterLines,
      preview,
    };
  },

  parseResult(output) {
    return {
      renderType: 'file-write',
      data: {
        path: output.path,
        mode: output.mode,
        encoding: output.encoding,
        created: output.created,
        replacements: output.replacements,
        beforeSize: output.beforeSize,
        afterSize: output.afterSize,
        beforeLines: output.beforeLines,
        afterLines: output.afterLines,
        preview: output.preview,
      },
    };
  },
};
