import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'conversations');

function convoPath(id) {
  return join(DATA_DIR, `${id}.json`);
}

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

export async function listConversations() {
  await ensureDataDir();
  const files = await readdir(DATA_DIR);
  const convos = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const data = JSON.parse(await readFile(join(DATA_DIR, f), 'utf-8'));
    convos.push({ id: data.id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt, messageCount: data.messages.length });
  }
  convos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return convos;
}

export async function getConversation(id) {
  await ensureDataDir();
  const p = convoPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, 'utf-8'));
}

export async function createConversation(id, title) {
  await ensureDataDir();
  const now = new Date().toISOString();
  const convo = { id, title, createdAt: now, updatedAt: now, messages: [] };
  await writeFile(convoPath(id), JSON.stringify(convo, null, 2));
  return convo;
}

export async function saveConversation(id, messages, title) {
  await ensureDataDir();
  const convo = await getConversation(id);
  if (!convo) return null;
  convo.messages = messages;
  convo.updatedAt = new Date().toISOString();
  if (title) convo.title = title;
  await writeFile(convoPath(id), JSON.stringify(convo, null, 2));
  return convo;
}

export async function deleteConversation(id) {
  await ensureDataDir();
  const p = convoPath(id);
  if (existsSync(p)) await unlink(p);
}
