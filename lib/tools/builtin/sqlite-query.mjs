import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_SQL_LENGTH = 10000;
const MAX_SOURCE_ID_LENGTH = 80;
const READONLY_SQL_PATTERN = /^\s*(select|with|pragma)\b/i;
const FORBIDDEN_SQL_PATTERN = /\b(insert|update|delete|replace|alter|drop|create|truncate|attach|detach|vacuum|reindex)\b/i;
const WORKSPACE_ROOT = resolve(process.cwd());

function requiredString(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function optionalString(value, name, max) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function optionalInteger(value, name, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function resolveWorkspacePath(path) {
  requiredString(path, 'path', 1000);
  const resolved = isAbsolute(path) ? resolve(path) : resolve(WORKSPACE_ROOT, path);
  const rel = relative(WORKSPACE_ROOT, resolved);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('SQLite source path must stay inside the workspace root');
  }
  return resolved;
}

function normalizeSource(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`sources[${index}] must be an object`);
  }
  const id = String(raw.id || raw.name || `source_${index + 1}`).trim();
  const path = String(raw.path || raw.file || '').trim();
  requiredString(id, `sources[${index}].id`, MAX_SOURCE_ID_LENGTH);
  requiredString(path, `sources[${index}].path`, 1000);
  return {
    id,
    path: resolveWorkspacePath(path),
  };
}

function configuredSources(config) {
  const sources = Array.isArray(config?.sources) ? config.sources : [];
  return sources.map(normalizeSource);
}

function sourceById(sources, sourceId) {
  if (!sources.length) throw new Error('No SQLite sources configured. Add config.sources in the tool settings.');
  const id = sourceId || sources[0].id;
  const source = sources.find(item => item.id === id);
  if (!source) throw new Error(`Unknown SQLite source: ${id}`);
  return source;
}

function assertReadonlySql(sql) {
  const trimmed = String(sql || '').trim();
  requiredString(trimmed, 'sql', MAX_SQL_LENGTH);
  if (!READONLY_SQL_PATTERN.test(trimmed)) {
    throw new Error('Only read-only SQLite SQL is allowed: SELECT, WITH, or PRAGMA');
  }
  if (FORBIDDEN_SQL_PATTERN.test(trimmed)) {
    throw new Error('SQLite SQL contains a forbidden write or administrative statement');
  }
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error('Multiple SQL statements are not allowed');
  }
}

function sourceForOutput(source) {
  return {
    id: source.id,
    path: relative(WORKSPACE_ROOT, source.path) || source.path,
  };
}

function valueForJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `[Blob ${value.byteLength} bytes]`;
  return value;
}

function normalizeRows(rows) {
  return rows.map(row => {
    const out = {};
    for (const [key, value] of Object.entries(row || {})) {
      out[key] = valueForJson(value);
    }
    return out;
  });
}

export const sqliteQueryTool = {
  id: 'sqlite_query',
  name: 'sqlite_query',
  title: 'SQLite Query',
  description: 'Run a read-only SQL query against a configured SQLite database file. Configure multiple sources through tool config.sources, each with id and path. Paths must stay inside the workspace. Only SELECT, WITH, and PRAGMA statements are allowed.',
  category: 'database',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'medium',
  defaultEnabled: false,
  timeoutMs: 10000,
  defaultConfig: {
    sources: [],
  },
  configSchema: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        description: 'Configured SQLite sources. Each source supports id and path or file. Paths must stay inside the workspace.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            path: { type: 'string' },
            file: { type: 'string' },
          },
        },
      },
    },
    additionalProperties: false,
  },
  configExamples: [
    {
      title: 'Workspace SQLite database',
      config: {
        sources: [
          {
            id: 'xwork',
            path: 'data/xwork.sqlite',
          },
        ],
      },
    },
    {
      title: 'Multiple SQLite databases',
      config: {
        sources: [
          {
            id: 'main',
            path: 'data/xwork.sqlite',
          },
          {
            id: 'reporting',
            file: 'data/reporting.sqlite',
          },
        ],
      },
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: {
        type: 'string',
        description: 'Configured SQLite source id. If omitted, the first configured source is used.',
      },
      sql: {
        type: 'string',
        description: 'Read-only SQLite SQL statement. Allowed starts: SELECT, WITH, PRAGMA. Multiple statements and write/admin keywords are blocked.',
      },
      limit: {
        type: 'number',
        description: `Maximum rows returned to the model. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.`,
      },
    },
    required: ['sql'],
    additionalProperties: false,
  },

  validate(input) {
    optionalString(input.sourceId, 'sourceId', MAX_SOURCE_ID_LENGTH);
    assertReadonlySql(input.sql);
    optionalInteger(input.limit, 'limit', { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
  },

  async before(input, { config }) {
    const sources = configuredSources(config);
    const source = sourceById(sources, input.sourceId);
    if (!existsSync(source.path)) throw new Error(`SQLite source file does not exist: ${sourceForOutput(source).path}`);
    return {
      source,
      sql: input.sql.trim(),
      limit: optionalInteger(input.limit, 'limit', { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT }),
    };
  },

  async handler(input) {
    const db = new DatabaseSync(input.source.path, { readOnly: true });
    try {
      const rows = normalizeRows(db.prepare(input.sql).all());
      const returnedRows = rows.slice(0, input.limit);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return {
        source: sourceForOutput(input.source),
        sql: input.sql,
        rowCount: rows.length,
        returnedRowCount: returnedRows.length,
        truncated: rows.length > returnedRows.length,
        columns,
        rows: returnedRows,
      };
    } finally {
      db.close();
    }
  },

  parseResult(output) {
    return {
      renderType: 'sqlite-query',
      data: {
        source: output.source,
        sql: output.sql,
        rowCount: output.rowCount,
        returnedRowCount: output.returnedRowCount,
        truncated: output.truncated,
        columns: output.columns,
        previewRows: output.rows.slice(0, 20),
      },
    };
  },

  __test: {
    configuredSources,
    assertReadonlySql,
  },
};
