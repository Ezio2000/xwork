import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deleteConversationDocument,
  getConversationDocument,
  listConversationDocuments,
  migrateLegacyConversations,
  putConversationDocument,
  updateConversationDocument,
} from './sqlite-store.mjs';
import { normalizeConversation, normalizeConversationTitle, normalizeMessageList, validateSafeId } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'conversations');
const conversationQueues = new Map();
let migrationPromise = null;

async function ensureDataDir() {
  if (!migrationPromise) {
    migrationPromise = migrateLegacyConversations({ dirPath: DATA_DIR, normalizeConversation });
  }
  await migrationPromise;
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
  const convos = (await listConversationDocuments())
    .map(data => normalizeConversation(data, data?.id))
    .filter(Boolean)
    .map(data => ({ id: data.id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt, messageCount: data.messages.length }));
  convos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return convos;
}

export async function getConversation(id) {
  validateSafeId(id, 'conversationId');
  await ensureDataDir();
  return normalizeConversation(await getConversationDocument(id), id);
}

export async function createConversation(id, title) {
  return withConversationQueue(id, async () => {
    await ensureDataDir();
    const now = new Date().toISOString();
    const convo = { id, title: normalizeConversationTitle(title), createdAt: now, updatedAt: now, messages: [] };
    await putConversationDocument(convo);
    return convo;
  });
}

export async function saveConversation(id, messages, title) {
  return withConversationQueue(id, async () => {
    await ensureDataDir();
    return updateConversationDocument(id, (current) => {
      const convo = normalizeConversation(current, id);
      if (!convo) return null;
      convo.messages = normalizeMessageList(messages);
      convo.updatedAt = new Date().toISOString();
      if (title) convo.title = normalizeConversationTitle(title);
      return convo;
    });
  });
}

export async function saveConversationUnlocked(id, messages, title) {
  validateSafeId(id, 'conversationId');
  await ensureDataDir();
  return updateConversationDocument(id, (current) => {
    const convo = normalizeConversation(current, id);
    if (!convo) return null;
    convo.messages = normalizeMessageList(messages);
    convo.updatedAt = new Date().toISOString();
    if (title) convo.title = normalizeConversationTitle(title);
    return convo;
  });
}

export async function deleteConversation(id) {
  return withConversationQueue(id, async () => {
    await ensureDataDir();
    await deleteConversationDocument(id);
  });
}
