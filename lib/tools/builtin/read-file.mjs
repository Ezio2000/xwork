import { readFile, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname, basename } from 'node:path';

const WORKSPACE_ROOT = resolve(process.cwd());
const MAX_PATH_LENGTH = 1000;
const SAMPLE_BYTES = 8192;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINES = 500;
const MAX_MAX_LINES = 2000;
const MIN_MAX_LINES = 1;
const SUPPORTED_ENCODINGS = new Set(['utf-8', 'utf8', 'gb18030', 'gbk']);

const DEFAULT_BLOCKED_GLOBS = ['**/node_modules/**', '**/.git/**'];

const BLOCKED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'heic', 'heif',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'wma', 'm4a',
  'zip', 'gz', 'tar', '7z', 'rar', 'bz2', 'xz', 'tgz',
  'exe', 'dll', 'so', 'dylib', 'wasm', 'pdb', 'bin', 'class', 'jar', 'war', 'o', 'a',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'pdf',
  'db', 'sqlite', 'sqlite3',
  'pem', 'key', 'p12', 'pfx', 'keystore',
]);

const MAGIC_CHECKS = [
  { kind: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { kind: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { kind: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { kind: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { kind: 'application/zip', bytes: [0x50, 0x4B, 0x03, 0x04] },
  { kind: 'application/gzip', bytes: [0x1F, 0x8B] },
  { kind: 'application/x-sqlite3', bytes: [0x53, 0x51, 0x4C, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6F, 0x72, 0x6D, 0x61, 0x74, 0x20, 0x33] },
  { kind: 'executable/pe', bytes: [0x4D, 0x5A] },
  { kind: 'executable/elf', bytes: [0x7F, 0x45, 0x4C, 0x46] },
];

const SECRET_BASENAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ed25519',
  'id_ecdsa',
]);

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function requiredString(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function normalizeEncoding(encoding) {
  const normalized = String(encoding || 'utf-8').toLowerCase();
  if (normalized === 'utf8') return 'utf-8';
  if (normalized === 'gbk') return 'gb18030';
  return SUPPORTED_ENCODINGS.has(normalized) ? normalized : 'utf-8';
}

function globToRegExp(pattern) {
  const normalized = String(pattern || '').replace(/\\/g, '/');
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAnyGlob(relPath, globs = []) {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of globs) {
    if (!pattern) continue;
    if (globToRegExp(pattern).test(normalized)) return pattern;
  }
  return null;
}

function isBlockedEnvFile(name) {
  const lower = name.toLowerCase();
  if (lower === '.env.example' || lower === '.env.sample' || lower === '.env.template') return false;
  return lower === '.env' || lower.startsWith('.env.');
}

function isSecretBasename(name) {
  const lower = name.toLowerCase();
  if (SECRET_BASENAMES.has(lower)) return true;
  if (lower.endsWith('.pem') || lower.endsWith('.key') && !lower.endsWith('.pub')) return true;
  return false;
}

function blockedExtensionReason(ext) {
  const normalized = String(ext || '').replace(/^\./, '').toLowerCase();
  if (!normalized) return null;
  if (BLOCKED_EXTENSIONS.has(normalized)) {
    return { code: 'blocked_extension', extension: normalized };
  }
  return null;
}

function detectMagicKind(buffer) {
  for (const check of MAGIC_CHECKS) {
    if (buffer.length < check.bytes.length) continue;
    if (check.bytes.every((byte, index) => buffer[index] === byte)) {
      return check.kind;
    }
  }
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }
  if (buffer.length >= 8 && String(buffer.subarray(4, 8)) === 'ftyp') {
    return 'video/mp4';
  }
  return null;
}

function nulRatio(buffer) {
  if (buffer.length === 0) return 0;
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0) count += 1;
  }
  return count / buffer.length;
}

function decodeBuffer(buffer, encoding) {
  const selected = normalizeEncoding(encoding);
  try {
    return new TextDecoder(selected === 'utf-8' ? 'utf-8' : selected).decode(buffer);
  } catch {
    throw new Error(`Unsupported encoding: ${encoding}`);
  }
}

function replacementRatio(text) {
  if (!text) return 0;
  const matches = text.match(/\uFFFD/g);
  return (matches?.length || 0) / Math.max(text.length, 1);
}

function classifyBinary(buffer, ext) {
  const extensionBlock = blockedExtensionReason(ext);
  if (extensionBlock) return extensionBlock;

  const sample = buffer.subarray(0, Math.min(buffer.length, SAMPLE_BYTES));
  const magic = detectMagicKind(sample);
  if (magic) return { code: 'binary_file', kind: magic };

  if (nulRatio(sample) > 0) {
    return { code: 'binary_file', kind: 'application/octet-stream' };
  }

  const decoded = decodeBuffer(sample, 'utf-8');
  if (replacementRatio(decoded) > 0.02) {
    return { code: 'binary_file', kind: 'text/invalid-utf8' };
  }

  return null;
}

async function resolveReadablePath(path) {
  requiredString(path, 'path', MAX_PATH_LENGTH);

  const resolved = isAbsolute(path) ? resolve(path) : resolve(WORKSPACE_ROOT, path);
  const rel = relative(WORKSPACE_ROOT, resolved);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('path must stay inside the workspace root');
  }
  if (!existsSync(resolved)) {
    throw new Error('file does not exist');
  }

  const canonical = await realpath(resolved);
  const canonicalRel = relative(WORKSPACE_ROOT, canonical);
  if (canonicalRel === '..' || canonicalRel.startsWith('..\\') || canonicalRel.startsWith('../') || isAbsolute(canonicalRel)) {
    throw new Error('path must stay inside the workspace root');
  }

  const fileStat = await stat(canonical);
  if (fileStat.isDirectory()) {
    throw new Error('path must be a file, not a directory');
  }

  return {
    absolutePath: canonical,
    relativePath: canonicalRel.split('\\').join('/'),
  };
}

function configuredValue(config, key, fallback) {
  const value = config?.[key];
  return value === undefined ? fallback : value;
}

function configuredBlockedGlobs(config) {
  const globs = configuredValue(config, 'blockedGlobs', DEFAULT_BLOCKED_GLOBS);
  return Array.isArray(globs) ? globs.map(item => String(item).trim()).filter(Boolean) : DEFAULT_BLOCKED_GLOBS;
}

function sliceLines(text, offset, limit, maxLines) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const totalLines = lines.length;
  const startLine = clampInteger(offset, 1, 1, Math.max(1, totalLines));
  const lineLimit = clampInteger(limit, maxLines, MIN_MAX_LINES, maxLines);
  const startIndex = startLine - 1;
  const selected = lines.slice(startIndex, startIndex + lineLimit);
  const endLine = totalLines === 0 ? 0 : startLine + selected.length - 1;
  const truncated = startIndex + selected.length < lines.length;

  return {
    totalLines,
    startLine: totalLines === 0 ? 0 : startLine,
    endLine,
    content: selected.join('\n'),
    truncated,
  };
}

function buildReadError(reason) {
  const err = new Error(reason.message || 'read_file rejected');
  err.code = reason.code;
  err.details = reason;
  return err;
}

export const readFileTool = {
  id: 'read_file',
  name: 'read_file',
  title: 'Read File',
  description:
    'Read a text file inside the workspace. Supports source code, configs, markdown, logs, and other UTF-8 or GB18030 text. Rejects images, archives, executables, databases, PDFs, Office files, and other binary formats. Use this when users reference file paths (including @path mentions) and you need actual file content. Use offset and limit for large files.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 10000,
  systemPrompt() {
    return [
      '# read_file guidance',
      '- If the user message includes workspace file paths (for example @src/app.js), treat them as references, not inlined content.',
      '- Call read_file to inspect the referenced files before making assumptions about file contents.',
      '- Prefer small slices first (offset/limit), then expand if needed.',
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
    const { absolutePath, relativePath } = await resolveReadablePath(input.path);
    const maxBytes = clampInteger(toolConfig.maxBytes, DEFAULT_MAX_BYTES, 1024, MAX_MAX_BYTES);
    const maxLines = clampInteger(toolConfig.maxLines, DEFAULT_MAX_LINES, MIN_MAX_LINES, MAX_MAX_LINES);
    const blockedGlobs = configuredBlockedGlobs(toolConfig);

    const matchedGlob = matchesAnyGlob(relativePath, blockedGlobs);
    if (matchedGlob) {
      throw buildReadError({
        code: 'blocked_path',
        message: `Path is blocked by policy: ${matchedGlob}`,
        path: relativePath,
        pattern: matchedGlob,
      });
    }

    const fileName = basename(absolutePath);
    if (isBlockedEnvFile(fileName)) {
      throw buildReadError({
        code: 'blocked_path',
        message: 'Refusing to read environment secret files (.env). Use .env.example when needed.',
        path: relativePath,
      });
    }
    if (isSecretBasename(fileName)) {
      throw buildReadError({
        code: 'blocked_path',
        message: 'Refusing to read secret key material.',
        path: relativePath,
      });
    }

    const ext = extname(fileName);
    const extensionBlock = blockedExtensionReason(ext);
    if (extensionBlock) {
      throw buildReadError({
        code: extensionBlock.code,
        message: `File extension is not supported for read_file: ${extensionBlock.extension}`,
        path: relativePath,
        extension: extensionBlock.extension,
        hint: 'Use a specialized tool such as sqlite_query for database files.',
      });
    }

    const fileStat = await stat(absolutePath);
    if (fileStat.size > maxBytes) {
      throw buildReadError({
        code: 'file_too_large',
        message: `File exceeds maxBytes (${maxBytes}). Use offset and limit on a smaller excerpt, or raise tool config maxBytes.`,
        path: relativePath,
        size: fileStat.size,
        maxBytes,
      });
    }

    const buffer = await readFile(absolutePath);
    const binaryReason = classifyBinary(buffer, ext);
    if (binaryReason) {
      throw buildReadError({
        ...binaryReason,
        message: binaryReason.code === 'blocked_extension'
          ? `File extension is not supported for read_file: ${binaryReason.extension}`
          : `File appears to be binary (${binaryReason.kind || 'unknown'}). read_file only supports text files.`,
        path: relativePath,
        hint: binaryReason.kind?.startsWith('image/')
          ? 'Binary image files are not supported.'
          : binaryReason.extension === 'pdf' || binaryReason.kind === 'application/pdf'
            ? 'Use web_fetch for remote PDFs or a dedicated parser.'
            : binaryReason.extension && ['db', 'sqlite', 'sqlite3'].includes(binaryReason.extension)
              ? 'Use sqlite_query for SQLite databases.'
              : 'Use shell_command only if explicitly enabled and appropriate.',
      });
    }

    const encoding = normalizeEncoding(input.encoding);
    const text = decodeBuffer(buffer, encoding);
    const slice = sliceLines(
      text,
      input.offset === undefined || input.offset === null ? 1 : Number(input.offset),
      input.limit === undefined || input.limit === null ? maxLines : Number(input.limit),
      maxLines,
    );

    return {
      path: relativePath,
      encoding,
      size: fileStat.size,
      ...slice,
    };
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
