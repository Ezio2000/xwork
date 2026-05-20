import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'xwork.sqlite');

let db = null;
let sqliteWriteQueue = Promise.resolve();

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function openDb() {
  if (db) return db;
  if (!existsSync(DATA_DIR)) {
    throw new Error(`Data directory does not exist: ${DATA_DIR}`);
  }
  const database = new DatabaseSync(DB_PATH);
  try {
    database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS documents (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA journal_mode = WAL;
  `);
  } catch (err) {
    try {
      database.close();
    } catch {}
    throw err;
  }
  db = database;
  return db;
}

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function readLegacyJson(filePath, defaultValue) {
  if (!filePath || !existsSync(filePath)) return cloneJson(defaultValue);
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return cloneJson(defaultValue);
  }
}

function getDocument(key) {
  const row = openDb().prepare('SELECT value FROM documents WHERE key = ?').get(key);
  if (!row) return undefined;
  return JSON.parse(row.value);
}

function putDocument(key, value) {
  openDb().prepare(`
    INSERT INTO documents (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), nowIso());
}

async function withWriteTransaction(task) {
  sqliteWriteQueue = sqliteWriteQueue.catch(() => {}).then(async () => {
    const database = openDb();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await task();
      database.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  });
  return sqliteWriteQueue;
}

export function createSqliteDocumentStore({
  key,
  legacyFilePath,
  defaultValue,
  normalize = value => value,
  serialize = value => value,
}) {
  let writeQueue = Promise.resolve();

  async function ensureFile() {
    await ensureDataDir();
    if (getDocument(key) !== undefined) return;
    const legacy = await readLegacyJson(legacyFilePath, defaultValue);
    putDocument(key, serialize(normalize(legacy)));
  }

  async function read() {
    await ensureFile();
    return normalize(getDocument(key));
  }

  async function write(data) {
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await ensureFile();
      return withWriteTransaction(async () => {
        const stored = serialize(data);
        putDocument(key, stored);
        return normalize(stored);
      });
    });
    return writeQueue;
  }

  async function update(mutator) {
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await ensureFile();
      return withWriteTransaction(async () => {
        const data = normalize(getDocument(key));
        const result = await mutator(data);
        const stored = serialize(data);
        putDocument(key, stored);
        return { data: normalize(stored), result };
      });
    });
    const { data, result } = await writeQueue;
    return result === undefined ? data : result;
  }

  return {
    key,
    read,
    write,
    update,
    ensureFile,
  };
}

export async function migrateLegacyConversations({ dirPath, normalizeConversation }) {
  await ensureDataDir();
  if (!existsSync(dirPath)) return;
  const existing = openDb().prepare('SELECT COUNT(*) AS count FROM conversations').get();
  if (Number(existing?.count || 0) > 0) return;

  const files = (await readdir(dirPath)).filter(file => file.endsWith('.json'));
  const insert = openDb().prepare(`
    INSERT OR REPLACE INTO conversations (id, value, updated_at)
    VALUES (?, ?, ?)
  `);
  for (const file of files) {
    const fallbackId = file.slice(0, -5);
    const raw = await readLegacyJson(join(dirPath, file), null);
    const convo = normalizeConversation(raw, fallbackId);
    if (!convo) continue;
    insert.run(convo.id, JSON.stringify(convo), convo.updatedAt || nowIso());
  }
}

export async function listConversationDocuments() {
  await ensureDataDir();
  const rows = openDb().prepare('SELECT value FROM conversations ORDER BY updated_at DESC').all();
  return rows.map(row => JSON.parse(row.value));
}

export async function getConversationDocument(id) {
  await ensureDataDir();
  const row = openDb().prepare('SELECT value FROM conversations WHERE id = ?').get(id);
  return row ? JSON.parse(row.value) : null;
}

export async function putConversationDocument(convo) {
  await ensureDataDir();
  await withWriteTransaction(async () => {
    openDb().prepare(`
      INSERT INTO conversations (id, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(convo.id, JSON.stringify(convo), convo.updatedAt || nowIso());
  });
  return convo;
}

export async function updateConversationDocument(id, mutator) {
  await ensureDataDir();
  return withWriteTransaction(async () => {
    const row = openDb().prepare('SELECT value FROM conversations WHERE id = ?').get(id);
    const current = row ? JSON.parse(row.value) : null;
    const next = await mutator(current);
    if (!next) return next;
    openDb().prepare(`
      INSERT INTO conversations (id, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(next.id, JSON.stringify(next), next.updatedAt || nowIso());
    return next;
  });
}

export async function deleteConversationDocument(id) {
  await ensureDataDir();
  await withWriteTransaction(async () => {
    openDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
  });
}
