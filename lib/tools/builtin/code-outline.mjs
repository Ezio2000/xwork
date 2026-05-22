import { extname } from 'node:path';

import {
  DEFAULT_BLOCKED_GLOBS,
  MAX_PATH_LENGTH,
  readWorkspaceTextFile,
} from '../../workspace-files.mjs';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINES = 4000;
const DEFAULT_MAX_SYMBOLS = 200;

const LANGUAGE_BY_EXT = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
};

function requiredString(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function configuredBlockedGlobs(config) {
  const globs = config?.blockedGlobs ?? DEFAULT_BLOCKED_GLOBS;
  return Array.isArray(globs) ? globs.map(item => String(item).trim()).filter(Boolean) : DEFAULT_BLOCKED_GLOBS;
}

function languageOf(path) {
  const ext = extname(path).slice(1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] || 'unknown';
}

function extractJsLike(content, isTs) {
  const symbols = [];
  const lines = content.split('\n');
  const patterns = [
    {
      kind: 'function',
      regex: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
    },
    {
      kind: 'class',
      regex: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: 'variable',
      regex: /^\s*(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\*?\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
    },
  ];

  if (isTs) {
    patterns.push(
      { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'type', regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
      { kind: 'enum', regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    );
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const { kind, regex } of patterns) {
      const match = line.match(regex);
      if (!match) continue;
      const name = match[1];
      const params = match[2] || match[3] || '';
      symbols.push({
        kind,
        name,
        line: i + 1,
        signature: line.trim().slice(0, 200),
        params: params ? params.trim() : undefined,
      });
      break;
    }
  }

  return symbols;
}

function extractPython(content) {
  const symbols = [];
  const lines = content.split('\n');
  const patterns = [
    { kind: 'function', regex: /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/ },
    { kind: 'class', regex: /^(\s*)class\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*:/ },
  ];
  for (let i = 0; i < lines.length; i += 1) {
    for (const { kind, regex } of patterns) {
      const match = lines[i].match(regex);
      if (!match) continue;
      const indent = (match[1] || '').length;
      const name = match[2];
      const params = match[3] || '';
      symbols.push({
        kind: indent === 0 ? kind : `${kind} (nested)`,
        name,
        line: i + 1,
        signature: lines[i].trim().slice(0, 200),
        params: params ? params.trim() : undefined,
        indent,
      });
      break;
    }
  }
  return symbols;
}

function extractGo(content) {
  const symbols = [];
  const lines = content.split('\n');
  const patterns = [
    { kind: 'function', regex: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(([^)]*)\)/ },
    { kind: 'type', regex: /^\s*type\s+([A-Za-z_][\w]*)\s+(struct|interface)\b/ },
  ];
  for (let i = 0; i < lines.length; i += 1) {
    for (const { kind, regex } of patterns) {
      const match = lines[i].match(regex);
      if (!match) continue;
      symbols.push({
        kind: kind === 'type' ? match[2] : kind,
        name: match[1],
        line: i + 1,
        signature: lines[i].trim().slice(0, 200),
      });
      break;
    }
  }
  return symbols;
}

function extractRust(content) {
  const symbols = [];
  const lines = content.split('\n');
  const patterns = [
    { kind: 'function', regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/ },
    { kind: 'struct', regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/ },
    { kind: 'enum', regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/ },
    { kind: 'trait', regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/ },
    { kind: 'impl', regex: /^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>,\s]*\s+for\s+)?([A-Za-z_][\w]*)/ },
  ];
  for (let i = 0; i < lines.length; i += 1) {
    for (const { kind, regex } of patterns) {
      const match = lines[i].match(regex);
      if (!match) continue;
      symbols.push({
        kind,
        name: match[1],
        line: i + 1,
        signature: lines[i].trim().slice(0, 200),
      });
      break;
    }
  }
  return symbols;
}

function extractJava(content) {
  const symbols = [];
  const lines = content.split('\n');
  const patterns = [
    { kind: 'class', regex: /^\s*(?:public|protected|private|abstract|final|static|\s)*class\s+([A-Z][\w]*)/ },
    { kind: 'interface', regex: /^\s*(?:public|protected|private|abstract|\s)*interface\s+([A-Z][\w]*)/ },
    { kind: 'enum', regex: /^\s*(?:public|protected|private|\s)*enum\s+([A-Z][\w]*)/ },
    {
      kind: 'method',
      regex: /^\s*(?:public|protected|private|static|final|abstract|synchronized|\s)+[\w<>\[\],\s.?]+\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws[^{;]*)?\s*[{;]/,
    },
  ];
  for (let i = 0; i < lines.length; i += 1) {
    for (const { kind, regex } of patterns) {
      const match = lines[i].match(regex);
      if (!match) continue;
      symbols.push({
        kind,
        name: match[1],
        line: i + 1,
        signature: lines[i].trim().slice(0, 200),
      });
      break;
    }
  }
  return symbols;
}

const EXTRACTORS = {
  javascript: content => extractJsLike(content, false),
  typescript: content => extractJsLike(content, true),
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  java: extractJava,
};

export const codeOutlineTool = {
  id: 'code_outline',
  name: 'code_outline',
  title: 'Code Outline',
  description:
    'Extract a structural outline (functions, classes, types, methods) from a workspace source file. ' +
    'Cheaper and more structured than read_file for orienting in a large file. Supported: JavaScript, TypeScript, Python, Go, Rust, Java.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 8000,
  systemPrompt() {
    return [
      '# code_outline',
      '- Use to orient inside an unfamiliar source file before read_file. Outputs declared functions, classes, types, and methods.',
      '- Symbols are heuristic (regex-based); do not assume completeness for macro-generated code.',
      '- If the file is short (under ~200 lines), prefer read_file directly.',
    ].join('\n');
  },
  defaultConfig: {
    maxSymbols: DEFAULT_MAX_SYMBOLS,
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
    blockedGlobs: DEFAULT_BLOCKED_GLOBS,
  },
  configSchema: {
    type: 'object',
    properties: {
      maxSymbols: { type: 'number', description: 'Maximum number of symbols returned.' },
      maxBytes: { type: 'number', description: 'Maximum file size to scan in bytes.' },
      maxLines: { type: 'number', description: 'Maximum number of lines to scan.' },
      blockedGlobs: {
        type: 'array',
        description: 'Workspace-relative glob patterns excluded from outline.',
        items: { type: 'string' },
      },
    },
    additionalProperties: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative or absolute path to a source file.' },
      maxSymbols: { type: 'number', description: 'Override the default symbol cap for this call.' },
    },
    required: ['path'],
    additionalProperties: false,
  },

  validate(input) {
    requiredString(input.path, 'path', MAX_PATH_LENGTH);
    if (input.maxSymbols !== undefined && input.maxSymbols !== null) {
      const n = Number(input.maxSymbols);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        throw new Error('maxSymbols must be an integer between 1 and 1000');
      }
    }
  },

  async handler(input, { config: toolConfig = {} }) {
    const language = languageOf(input.path);
    const extractor = EXTRACTORS[language];
    if (!extractor) {
      const supported = Object.keys(EXTRACTORS).join(', ');
      throw new Error(`Unsupported language for code_outline (extension: ${extname(input.path) || 'none'}). Supported: ${supported}`);
    }

    const maxBytes = Number.isFinite(Number(toolConfig.maxBytes)) ? Number(toolConfig.maxBytes) : DEFAULT_MAX_BYTES;
    const maxLines = Number.isFinite(Number(toolConfig.maxLines)) ? Number(toolConfig.maxLines) : DEFAULT_MAX_LINES;
    const maxSymbols = Math.min(
      Number.isFinite(Number(input.maxSymbols)) ? Number(input.maxSymbols)
        : Number.isFinite(Number(toolConfig.maxSymbols)) ? Number(toolConfig.maxSymbols) : DEFAULT_MAX_SYMBOLS,
      1000,
    );
    const blockedGlobs = configuredBlockedGlobs(toolConfig);

    const file = await readWorkspaceTextFile(input.path, {
      blockedGlobs,
      maxBytes,
      maxLines,
      offset: 1,
      limit: maxLines,
    });

    const symbols = extractor(file.content);
    const truncated = symbols.length > maxSymbols;

    return {
      path: file.path,
      language,
      totalLines: file.totalLines,
      scannedLines: file.endLine,
      symbols: symbols.slice(0, maxSymbols),
      symbolCount: Math.min(symbols.length, maxSymbols),
      totalSymbols: symbols.length,
      truncated,
    };
  },

  parseResult(output) {
    return {
      renderType: 'symbol-list',
      data: {
        path: output.path,
        language: output.language,
        totalLines: output.totalLines,
        scannedLines: output.scannedLines,
        symbols: output.symbols,
        symbolCount: output.symbolCount,
        totalSymbols: output.totalSymbols,
        truncated: output.truncated,
      },
    };
  },
};
