import { MAX_TITLE_LEN, isPlainObject, isSafeId, fail } from './common.mjs';
import { validateChannelPayload } from './channel.mjs';
import { validateChannelPricing } from './pricing.mjs';

export function validateConversationTitle(value) {
  if (value === undefined || value === null || value === '') return 'New Chat';
  if (typeof value !== 'string') fail('title must be a string');
  return value.slice(0, MAX_TITLE_LEN);
}

export const normalizeConversationTitle = validateConversationTitle;

function normalizeContentPart(part) {
  if (!isPlainObject(part) || typeof part.type !== 'string' || !part.type) return null;
  const out = { ...part, type: part.type };
  if (out.text !== undefined && typeof out.text !== 'string') out.text = String(out.text);
  if (out.content !== undefined && typeof out.content !== 'string' && !Array.isArray(out.content)) {
    out.content = JSON.stringify(out.content);
  }
  return out;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(normalizeContentPart).filter(Boolean);
}

export function normalizeMessage(message) {
  if (!isPlainObject(message)) return null;
  if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) return null;
  const out = {
    ...message,
    role: message.role,
    content: normalizeContent(message.content),
  };
  if (typeof out.model !== 'string') delete out.model;
  if (Array.isArray(message.blocks)) {
    out.blocks = message.blocks
      .filter(block => isPlainObject(block) && typeof block.type === 'string' && block.type)
      .map(block => ({ ...block }));
  } else {
    delete out.blocks;
  }
  if (!Array.isArray(out.sources)) delete out.sources;
  if (typeof out.searchCount !== 'number') delete out.searchCount;
  if (!isPlainObject(out.trace)) delete out.trace;
  return out;
}

export function normalizeMessageList(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeMessage).filter(Boolean);
}

export function normalizeConversation(data, fallbackId) {
  if (!isPlainObject(data)) return null;
  const id = isSafeId(data.id) ? data.id : fallbackId;
  if (!isSafeId(id)) return null;
  const now = new Date().toISOString();
  return {
    id,
    title: typeof data.title === 'string' ? data.title.slice(0, MAX_TITLE_LEN) : 'New Chat',
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : now,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now,
    messages: normalizeMessageList(data.messages),
  };
}

function normalizeChannel(channel) {
  if (!isPlainObject(channel) || !isSafeId(channel.id)) return null;
  try {
    const normalized = validateChannelPayload(channel, { partial: false });
    const pricing = validateChannelPricing(channel.pricing) ?? { models: {} };
    return { id: channel.id, ...normalized, pricing };
  } catch {
    return null;
  }
}

function normalizeWorkspace(workspace) {
  if (!isPlainObject(workspace)) return { root: null, label: null };
  const rawRoot = workspace.root;
  const rawLabel = workspace.label;
  const root = typeof rawRoot === 'string' && rawRoot.trim() ? rawRoot.trim() : null;
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim().slice(0, 80) : null;
  return { root, label };
}

export function normalizeAppConfig(cfg) {
  const channels = Array.isArray(cfg?.channels)
    ? cfg.channels.map(normalizeChannel).filter(Boolean)
    : [];
  const activeChannelId = isSafeId(cfg?.activeChannelId) ? cfg.activeChannelId : null;
  const activeModel = typeof cfg?.activeModel === 'string' ? cfg.activeModel : null;
  const workspace = normalizeWorkspace(cfg?.workspace);
  return { channels, activeChannelId, activeModel, workspace };
}
