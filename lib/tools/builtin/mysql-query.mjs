const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_SQL_LENGTH = 10000;
const MAX_SOURCE_ID_LENGTH = 80;
const READONLY_SQL_PATTERN = /^\s*(select|show|describe|desc|explain|with)\b/i;
const FORBIDDEN_SQL_PATTERN = /\b(insert|update|delete|replace|alter|drop|create|truncate|rename|grant|revoke|call|load|outfile|infile|set)\b/i;

function optionalString(value, name, max) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function requiredString(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
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

function normalizeSource(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`sources[${index}] must be an object`);
  }
  const id = String(raw.id || raw.name || `source_${index + 1}`).trim();
  const host = String(raw.host || raw.ip || '').trim();
  const user = String(raw.username || raw.user || '').trim();
  const password = raw.password === undefined || raw.password === null ? '' : String(raw.password);
  const database = raw.database === undefined || raw.database === null ? '' : String(raw.database).trim();
  const port = optionalInteger(raw.port, `sources[${index}].port`, { min: 1, max: 65535, fallback: 3306 });

  requiredString(id, `sources[${index}].id`, MAX_SOURCE_ID_LENGTH);
  requiredString(host, `sources[${index}].host`, 255);
  requiredString(user, `sources[${index}].username`, 255);
  optionalString(database, `sources[${index}].database`, 255);
  return { id, host, port, user, password, database };
}

function configuredSources(config) {
  const sources = Array.isArray(config?.sources) ? config.sources : [];
  return sources.map(normalizeSource);
}

function sourceById(sources, sourceId) {
  if (!sources.length) throw new Error('No MySQL sources configured. Add config.sources in the tool settings.');
  const id = sourceId || sources[0].id;
  const source = sources.find(item => item.id === id);
  if (!source) throw new Error(`Unknown MySQL source: ${id}`);
  return source;
}

function assertReadonlySql(sql) {
  const trimmed = String(sql || '').trim();
  requiredString(trimmed, 'sql', MAX_SQL_LENGTH);
  if (!READONLY_SQL_PATTERN.test(trimmed)) {
    throw new Error('Only read-only SQL is allowed: SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, or WITH');
  }
  if (FORBIDDEN_SQL_PATTERN.test(trimmed)) {
    throw new Error('SQL contains a forbidden write or administrative statement');
  }
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error('Multiple SQL statements are not allowed');
  }
}

function redactedSource(source) {
  return {
    id: source.id,
    host: source.host,
    port: source.port,
    database: source.database || '',
    user: source.user,
  };
}

function valueForJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  return value;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = valueForJson(value);
    }
    return out;
  });
}

export const mysqlQueryTool = {
  id: 'mysql_query',
  name: 'mysql_query',
  title: 'MySQL Query',
  description: 'Run a read-only SQL query against a configured MySQL data source. Configure multiple sources through tool config.sources, each with id, host or ip, port, username, password, and optional database. Only SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, and WITH statements are allowed.',
  category: 'database',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'high',
  defaultEnabled: false,
  timeoutMs: 30000,
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: {
        type: 'string',
        description: 'Configured source id. If omitted, the first configured source is used.',
      },
      sql: {
        type: 'string',
        description: 'Read-only SQL statement. Allowed starts: SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH. Multiple statements and write/admin keywords are blocked.',
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
    return {
      source,
      sql: input.sql.trim(),
      limit: optionalInteger(input.limit, 'limit', { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT }),
      connectTimeoutMs: optionalInteger(config?.connectTimeoutMs, 'connectTimeoutMs', { min: 1000, max: 60000, fallback: DEFAULT_TIMEOUT_MS }),
    };
  },

  async handler(input, { signal }) {
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({
      host: input.source.host,
      port: input.source.port,
      user: input.source.user,
      password: input.source.password,
      database: input.source.database || undefined,
      connectTimeout: input.connectTimeoutMs,
      multipleStatements: false,
      rowsAsArray: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await connection.end().catch(() => {});
    };
    const onAbort = () => {
      closed = true;
      connection.destroy();
    };

    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
      await connection.query(`SET SESSION MAX_EXECUTION_TIME=${Math.max(1000, input.connectTimeoutMs)}`).catch(() => {});
      const [rows, fields] = await connection.query(input.sql);
      const normalized = normalizeRows(rows);
      const returnedRows = normalized.slice(0, input.limit);
      return {
        source: redactedSource(input.source),
        sql: input.sql,
        rowCount: normalized.length,
        returnedRowCount: returnedRows.length,
        truncated: normalized.length > returnedRows.length,
        columns: Array.isArray(fields) ? fields.map(field => field.name) : [],
        rows: returnedRows,
      };
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      await close();
    }
  },

  parseResult(output) {
    return {
      renderType: 'mysql-query',
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
