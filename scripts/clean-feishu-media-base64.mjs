import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2] || 'data/xwork.sqlite';
const shouldVacuum = process.argv.includes('--vacuum');
const db = new DatabaseSync(dbPath);

function scrubString(value) {
  let out = String(value || '');
  out = out.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/gi, '[feishu image data omitted]');
  out = out.replace(/"contentBase64"\s*:\s*"[A-Za-z0-9+/=\r\n]+"/gi, '"contentBase64":"[binary content omitted]"');
  out = out.replace(/\\"contentBase64\\"\s*:\s*\\"[A-Za-z0-9+/=\\r\\n]+\\"/gi, '\\"contentBase64\\":\\"[binary content omitted]\\"');
  out = out.replace(/contentBase64[^A-Za-z0-9+/=]{1,20}[A-Za-z0-9+/=]{200,}/gi, 'contentBase64: [binary content omitted]');
  out = out.replace(/iVBORw0KGgo[A-Za-z0-9+/=\r\n]{200,}/g, '[png base64 omitted]');
  out = out.replace(/\/9j\/[A-Za-z0-9+/=\r\n]{200,}/g, '[jpeg base64 omitted]');
  return out;
}

function scrubJsonValue(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(contentBase64|base64|dataUrl|dataURL)$/i.test(key)) {
        out[key] = '[binary content omitted]';
      } else {
        out[key] = scrubJsonValue(item);
      }
    }
    return out;
  }
  return value;
}

function scrubStoredValue(raw) {
  try {
    return JSON.stringify(scrubJsonValue(JSON.parse(raw)));
  } catch {
    return scrubString(raw);
  }
}

function cleanTable(table, keyColumn) {
  const rows = db.prepare(
    `select ${keyColumn} as id, value from ${table} where value like '%data:image%' or value like '%contentBase64%' or value like '%iVBORw0KGgo%'`,
  ).all();
  const update = db.prepare(`update ${table} set value = ?, updated_at = ? where ${keyColumn} = ?`);
  let changed = 0;
  for (const row of rows) {
    const next = scrubStoredValue(row.value);
    if (next !== row.value) {
      update.run(next, new Date().toISOString(), row.id);
      changed += 1;
    }
  }
  return { scanned: rows.length, changed };
}

const result = {
  conversations: cleanTable('conversations', 'id'),
  documents: cleanTable('documents', 'key'),
};

if (shouldVacuum) db.exec('vacuum');
console.log(JSON.stringify(result, null, 2));
