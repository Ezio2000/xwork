import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname, basename, join, dirname } from 'node:path';

export const WORKSPACE_ROOT = resolve(process.cwd());
export const DEFAULT_BLOCKED_GLOBS = ['**/node_modules/**', '**/.git/**'];
export const MAX_PATH_LENGTH = 1000;
export const SAMPLE_BYTES = 8192;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_LINES = 120;
export const MAX_MAX_LINES = 2000;
export const MIN_MAX_LINES = 1;
export const DEFAULT_GLOB_LIMIT = 50;
export const MAX_GLOB_LIMIT = 200;
export const DEFAULT_GREP_HEAD_LIMIT = 50;
export const MAX_GREP_HEAD_LIMIT = 200;
export const DEFAULT_GREP_CONTEXT = 0;
export const MAX_GREP_CONTEXT = 5;
export const GREP_MAX_FILE_BYTES = 512 * 1024;
export const GREP_MAX_SCAN_FILES = 500;
export const MAX_GREP_PATTERN_LENGTH = 500;

const SUPPORTED_ENCODINGS = new Set(['utf-8', 'utf8', 'gb18030', 'gbk']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'coverage', '.cursor', '.idea', '.vscode']);
const INDEX_MAX_DEPTH = 12;
const INDEX_MAX_FILES = 5000;
const INDEX_TTL_MS = 30_000;

export const BLOCKED_EXTENSIONS = new Set([
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

const SECRET_BASENAMES = new Set(['id_rsa', 'id_dsa', 'id_ed25519', 'id_ecdsa']);
let fileIndexCache = { builtAt: 0, files: [] };

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function requiredString(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

export function normalizeEncoding(encoding) {
  const normalized = String(encoding || 'utf-8').toLowerCase();
  if (normalized === 'utf8') return 'utf-8';
  if (normalized === 'gbk') return 'gb18030';
  return SUPPORTED_ENCODINGS.has(normalized) ? normalized : 'utf-8';
}

export function globToRegExp(pattern) {
  const normalized = String(pattern || '').replace(/\\/g, '/');
  const leadingDoubleStar = /^\*\*\//;
  const hasLeadingDoubleStar = leadingDoubleStar.test(normalized);
  const body = normalized.replace(leadingDoubleStar, '');
  const escaped = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  const prefix = hasLeadingDoubleStar ? '(?:.*/)?' : '';
  return new RegExp(`^${prefix}${escaped}$`, 'i');
}

export function matchesAnyGlob(relPath, globs = []) {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of globs) {
    if (!pattern) continue;
    if (globToRegExp(pattern).test(normalized)) return pattern;
  }
  return null;
}

export function isBlockedEnvFile(name) {
  const lower = name.toLowerCase();
  if (lower === '.env.example' || lower === '.env.sample' || lower === '.env.template') return false;
  return lower === '.env' || lower.startsWith('.env.');
}

export function isSecretBasename(name) {
  const lower = name.toLowerCase();
  if (SECRET_BASENAMES.has(lower)) return true;
  if (lower.endsWith('.pem') || (lower.endsWith('.key') && !lower.endsWith('.pub'))) return true;
  return false;
}

export function blockedExtensionReason(ext) {
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

export function decodeBuffer(buffer, encoding) {
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

export function classifyBinary(buffer, ext) {
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

export function getPathPolicyFailure(relativePath, fileName, { blockedGlobs = DEFAULT_BLOCKED_GLOBS } = {}) {
  const matchedGlob = matchesAnyGlob(relativePath, blockedGlobs);
  if (matchedGlob) {
    return { code: 'blocked_path', message: `Path is blocked by policy: ${matchedGlob}`, path: relativePath };
  }
  if (isBlockedEnvFile(fileName)) {
    return { code: 'blocked_path', message: 'Refusing to read environment secret files (.env).', path: relativePath };
  }
  if (isSecretBasename(fileName)) {
    return { code: 'blocked_path', message: 'Refusing to read secret key material.', path: relativePath };
  }
  const extensionBlock = blockedExtensionReason(extname(fileName));
  if (extensionBlock) {
    return {
      code: extensionBlock.code,
      message: `File extension is not supported: ${extensionBlock.extension}`,
      path: relativePath,
      extension: extensionBlock.extension,
    };
  }
  return null;
}

export function isIndexableRelativePath(relativePath, fileName, options = {}) {
  if (!relativePath || !fileName) return false;
  return !getPathPolicyFailure(relativePath, fileName, options);
}

export async function resolveWorkspaceFilePath(path) {
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
    fileName: basename(canonical),
  };
}

export function sliceLines(text, offset, limit, maxLines) {
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

export async function readWorkspaceTextFile(path, {
  blockedGlobs = DEFAULT_BLOCKED_GLOBS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
  offset = 1,
  limit,
  encoding = 'utf-8',
} = {}) {
  const { absolutePath, relativePath, fileName } = await resolveWorkspaceFilePath(path);
  const policyFailure = getPathPolicyFailure(relativePath, fileName, { blockedGlobs });
  if (policyFailure) {
    const err = new Error(policyFailure.message);
    err.code = policyFailure.code;
    err.details = policyFailure;
    throw err;
  }

  const fileStat = await stat(absolutePath);
  if (fileStat.size > maxBytes) {
    const err = new Error(`File exceeds maxBytes (${maxBytes}).`);
    err.code = 'file_too_large';
    err.details = { path: relativePath, size: fileStat.size, maxBytes };
    throw err;
  }

  const buffer = await readFile(absolutePath);
  const binaryReason = classifyBinary(buffer, extname(fileName));
  if (binaryReason) {
    const err = new Error(`File appears to be binary (${binaryReason.kind || 'unknown'}).`);
    err.code = 'binary_file';
    err.details = { ...binaryReason, path: relativePath };
    throw err;
  }

  const normalizedEncoding = normalizeEncoding(encoding);
  const text = decodeBuffer(buffer, normalizedEncoding);
  const slice = sliceLines(
    text,
    offset,
    limit === undefined || limit === null ? maxLines : limit,
    maxLines,
  );

  return {
    path: relativePath,
    encoding: normalizedEncoding,
    size: fileStat.size,
    ...slice,
  };
}

async function walkWorkspaceFiles(dirAbs, dirRel, depth, files, blockedGlobs) {
  if (depth > INDEX_MAX_DEPTH || files.length >= INDEX_MAX_FILES) return;

  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (files.length >= INDEX_MAX_FILES) return;
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const childRel = dirRel ? `${dirRel}/${name}` : name;
      const childPolicy = getPathPolicyFailure(childRel, name, { blockedGlobs });
      if (childPolicy?.code === 'blocked_path') continue;
      await walkWorkspaceFiles(join(dirAbs, name), childRel, depth + 1, files, blockedGlobs);
      continue;
    }
    if (!entry.isFile()) continue;

    const relativePath = dirRel ? `${dirRel}/${name}`.replace(/\\/g, '/') : name;
    if (!isIndexableRelativePath(relativePath, name, { blockedGlobs })) continue;
    files.push({
      path: relativePath,
      name,
      directory: dirRel.replace(/\\/g, '/') || '.',
    });
  }
}

async function getFileIndex({ blockedGlobs = DEFAULT_BLOCKED_GLOBS, force = false } = {}) {
  const now = Date.now();
  if (!force && fileIndexCache.files.length > 0 && now - fileIndexCache.builtAt < INDEX_TTL_MS) {
    return fileIndexCache.files;
  }

  const files = [];
  await walkWorkspaceFiles(WORKSPACE_ROOT, '', 0, files, blockedGlobs);
  fileIndexCache = { builtAt: now, files };
  return files;
}

function scoreFileMatch(file, query) {
  const q = query.toLowerCase();
  const path = file.path.toLowerCase();
  const name = file.name.toLowerCase();
  if (path === q || name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (path.startsWith(q)) return 2;
  if (name.includes(q)) return 3;
  if (path.includes(q)) return 4;
  return 99;
}

export async function searchWorkspaceFiles({
  query = '',
  limit = 20,
  blockedGlobs = DEFAULT_BLOCKED_GLOBS,
} = {}) {
  const normalizedLimit = clampInteger(limit, 20, 1, 50);
  const q = String(query || '').trim().toLowerCase();
  const files = await getFileIndex({ blockedGlobs });

  const ranked = (q
    ? files
      .map(file => ({ file, score: scoreFileMatch(file, q) }))
      .filter(item => item.score < 99)
      .sort((a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path))
    : files.map(file => ({ file, score: 0 })))
    .slice(0, normalizedLimit)
    .map(item => item.file);

  return {
    query: q,
    files: ranked,
    indexedCount: files.length,
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSearchRegex(pattern, { caseInsensitive = false } = {}) {
  const flags = caseInsensitive ? 'i' : '';
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(escapeRegex(pattern), flags);
  }
}

function normalizeWorkspacePrefix(path) {
  const value = String(path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value) return '';
  return value.endsWith('/') ? value : `${value}/`;
}

function matchesPathPrefix(filePath, prefix) {
  if (!prefix) return true;
  const normalizedPrefix = normalizeWorkspacePrefix(prefix);
  if (!normalizedPrefix) return true;
  return filePath === normalizedPrefix.slice(0, -1) || filePath.startsWith(normalizedPrefix);
}

function filterIndexedFiles(files, { path, glob, query } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return files.filter(file => {
    if (!matchesPathPrefix(file.path, path)) return false;
    if (glob && !globToRegExp(glob).test(file.path)) return false;
    if (q && !file.path.toLowerCase().includes(q) && !file.name.toLowerCase().includes(q)) return false;
    return true;
  });
}

export async function listWorkspaceFilesByGlob({
  pattern,
  path,
  query = '',
  limit = DEFAULT_GLOB_LIMIT,
  blockedGlobs = DEFAULT_BLOCKED_GLOBS,
} = {}) {
  requiredString(pattern, 'pattern', MAX_PATH_LENGTH);
  const normalizedLimit = clampInteger(limit, DEFAULT_GLOB_LIMIT, 1, MAX_GLOB_LIMIT);
  const files = await getFileIndex({ blockedGlobs });
  const globPattern = String(pattern).trim().replace(/\\/g, '/');
  const filtered = filterIndexedFiles(files, {
    path,
    glob: globPattern,
    query,
  })
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, normalizedLimit);

  return {
    pattern: globPattern,
    path: path || null,
    query: String(query || '').trim(),
    files: filtered,
    indexedCount: files.length,
    truncated: filtered.length >= normalizedLimit,
  };
}

function collectLineMatches(lines, regex, context) {
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!regex.test(line)) continue;
    regex.lastIndex = 0;

    const before = [];
    const after = [];
    for (let offset = 1; offset <= context; offset += 1) {
      if (index - offset >= 0) before.unshift(lines[index - offset]);
      if (index + offset < lines.length) after.push(lines[index + offset]);
    }

    matches.push({
      line: index + 1,
      content: line,
      before,
      after,
    });
  }
  return matches;
}

export async function grepWorkspaceFiles({
  pattern,
  path,
  glob,
  caseInsensitive = false,
  context = DEFAULT_GREP_CONTEXT,
  headLimit = DEFAULT_GREP_HEAD_LIMIT,
  blockedGlobs = DEFAULT_BLOCKED_GLOBS,
} = {}) {
  requiredString(pattern, 'pattern', MAX_GREP_PATTERN_LENGTH);
  const normalizedLimit = clampInteger(headLimit, DEFAULT_GREP_HEAD_LIMIT, 1, MAX_GREP_HEAD_LIMIT);
  const normalizedContext = clampInteger(context, DEFAULT_GREP_CONTEXT, 0, MAX_GREP_CONTEXT);
  const regex = buildSearchRegex(pattern, { caseInsensitive: Boolean(caseInsensitive) });
  const files = await getFileIndex({ blockedGlobs });
  const candidates = filterIndexedFiles(files, { path, glob }).slice(0, GREP_MAX_SCAN_FILES);

  const matches = [];
  let scannedFiles = 0;
  let skippedLargeFiles = 0;

  for (const file of candidates) {
    if (matches.length >= normalizedLimit) break;
    scannedFiles += 1;

    let absolutePath;
    try {
      ({ absolutePath } = await resolveWorkspaceFilePath(file.path));
    } catch {
      continue;
    }

    const fileStat = await stat(absolutePath);
    if (fileStat.size > GREP_MAX_FILE_BYTES) {
      skippedLargeFiles += 1;
      continue;
    }

    const buffer = await readFile(absolutePath);
    const binaryReason = classifyBinary(buffer, extname(file.name));
    if (binaryReason) continue;

    const text = decodeBuffer(buffer, 'utf-8');
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const lineMatches = collectLineMatches(lines, regex, normalizedContext);

    for (const item of lineMatches) {
      matches.push({
        path: file.path,
        line: item.line,
        content: item.content,
        before: item.before,
        after: item.after,
      });
      if (matches.length >= normalizedLimit) break;
    }
  }

  return {
    pattern,
    path: path || null,
    glob: glob || null,
    caseInsensitive: Boolean(caseInsensitive),
    context: normalizedContext,
    matches,
    matchCount: matches.length,
    truncated: matches.length >= normalizedLimit,
    scannedFiles,
    skippedLargeFiles,
    candidateCount: candidates.length,
    indexedCount: files.length,
  };
}

export function invalidateWorkspaceFileIndex() {
  fileIndexCache = { builtAt: 0, files: [] };
}

