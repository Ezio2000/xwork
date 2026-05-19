import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deleteJsonFile, ensureJsonDir, listJsonFiles, readJsonFile, writeJsonFile } from './json-store.mjs';
import { normalizeConversation, normalizeConversationTitle, normalizeMessageList, validateSafeId } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'conversations');
const conversationQueues = new Map();

function convoPath(id) {
  validateSafeId(id, 'conversationId');
  return join(DATA_DIR, `${id}.json`);
}

async function ensureDataDir() {
  await ensureJsonDir(DATA_DIR);
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
  const files = await listJsonFiles(DATA_DIR);
  const convos = [];
  for (const f of files) {
    try {
      const fallbackId = f.slice(0, -5);
      const data = await readJsonFile(join(DATA_DIR, f), {
        defaultValue: null,
        normalize: raw => normalizeConversation(raw, fallbackId),
      });
      if (!data) continue;
      convos.push({ id: data.id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt, messageCount: data.messages.length });
    } catch {}
  }
  convos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return convos;
}

export async function getConversation(id) {
  await ensureDataDir();
  return readJsonFile(convoPath(id), {
    defaultValue: null,
    normalize: raw => normalizeConversation(raw, id),
  });
}

export async function createConversation(id, title) {
  return withConversationQueue(id, async () => {
    await ensureDataDir();
    const now = new Date().toISOString();
    const convo = { id, title: normalizeConversationTitle(title), createdAt: now, updatedAt: now, messages: [] };
    await writeJsonFile(convoPath(id), convo);
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
    await writeJsonFile(convoPath(id), convo);
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
  await writeJsonFile(convoPath(id), convo);
  return convo;
}

export async function deleteConversation(id) {
  return withConversationQueue(id, async () => {
    await ensureDataDir();
    await deleteJsonFile(convoPath(id));
  });
}
