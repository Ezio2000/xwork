import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConversation, normalizeConversationTitle, normalizeMessageList, validateSafeId } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'conversations');
const conversationQueues = new Map();

function convoPath(id) {
  validateSafeId(id, 'conversationId');
  return join(DATA_DIR, `${id}.json`);
}

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

export async function withConversationQueue(id, task) {
  validateSafeId(id, 'conversationId');
  const prev = conversationQueues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  conversationQueues.set(id, next);
  try {
    return await next;
  } finally {
    if (conversationQueues.get(id) === next) {
      conversationQueues.delete(id);
    }
  }
}

export async function listConversations() {
  await ensureDataDir();
  const files = await readdir(DATA_DIR);
  const convos = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const fallbackId = f.slice(0, -5);
      const data = normalizeConversation(JSON.parse(await readFile(join(DATA_DIR, f), 'utf-8')), fallbackId);
      if (!data) continue;
      convos.push({ id: data.id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt, messageCount: data.messages.length });
    } catch {}
  }
  convos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return convos;
}

export async function getConversation(id) {
  await ensureDataDir();
  const p = convoPath(id);
  if (!existsSync(p)) return null;
  return normalizeConversation(JSON.parse(await readFile(p, 'utf-8')), id);
}

export async function createConversation(id, title) {
  return withConversationQueue(id, async () => {
    await ensureDataDir();
    const now = new Date().toISOString();
    const convo = { id, title: normalizeConversationTitle(title), createdAt: now, updatedAt: now, messages: [] };
    await writeFile(convoPath(id), JSON.stringify(convo, null, 2));
    return convo;
  });
}

export async function saveConversation(id, messages, title) {
  return withConversationQueue(id, async () => {
    await ensureDataDir();
    const convo = await getConversation(id);
    if (!convo) return null;
    convo.messages = normalizeMessageList(messages);
    convo.updatedAt = new Date().toISOString();
    if (title) convo.title = normalizeConversationTitle(title);
    await writeFile(convoPath(id), JSON.stringify(convo, null, 2));
    return convo;
  });
}

export async function saveConversationUnlocked(id, messages, title) {
  await ensureDataDir();
  const convo = await getConversation(id);
  if (!convo) return null;
  convo.messages = normalizeMessageList(messages);
  convo.updatedAt = new Date().toISOString();
  if (title) convo.title = normalizeConversationTitle(title);
  await writeFile(convoPath(id), JSON.stringify(convo, null, 2));
  return convo;
}

export async function deleteConversation(id) {
  return withConversationQueue(id, async () => {
    await ensureDataDir();
    const p = convoPath(id);
    if (existsSync(p)) await unlink(p);
  });
}
