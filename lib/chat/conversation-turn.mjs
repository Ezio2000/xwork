import * as storage from '../storage.mjs';
import { titleFromMessage } from './message-projector.mjs';
import { requireImageAsset } from '../image-assets.mjs';

function isReplayableTraceMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) return false;
  if (typeof message.content === 'string') return message.content.trim().length > 0;
  return Array.isArray(message.content) && message.content.length > 0;
}

function sameReplayMessage(a, b) {
  if (!a || !b || a.role !== b.role) return false;
  try {
    return JSON.stringify(a.content) === JSON.stringify(b.content);
  } catch {
    return false;
  }
}

function replayMessagesFromStoredMessage(message, previousMessage) {
  if (message?.role !== 'assistant') return [message];
  const traceMessages = Array.isArray(message.trace?.messages)
    ? message.trace.messages.filter(isReplayableTraceMessage)
    : [];
  if (!traceMessages.length) return [message];
  return sameReplayMessage(previousMessage, traceMessages[0])
    ? traceMessages.slice(1)
    : traceMessages;
}

export function buildReplayHistory(messages = []) {
  const out = [];
  for (const message of messages || []) {
    out.push(...replayMessagesFromStoredMessage(message, out.at(-1)));
  }
  return out;
}

export async function loadConversationState(conversationId) {
  let history = [];
  let replayHistory = [];
  let existingTitle = '';
  let originalMessageCount = 0;

  if (conversationId) {
    const convo = await storage.getConversation(conversationId);
    if (convo) {
      history = convo.messages;
      replayHistory = buildReplayHistory(history);
      existingTitle = convo.title || '';
      originalMessageCount = history.length;
    }
  }

  return { history, replayHistory, existingTitle, originalMessageCount };
}

export async function buildUserMessageContent(message, images = []) {
  const content = [];
  if (message && message.trim()) {
    content.push({ type: 'text', text: message.trim() });
  }
  for (const image of images || []) {
    const asset = await requireImageAsset(image.id);
    content.push({
      type: 'image',
      source: {
        type: 'xwork_image',
        image_id: asset.id,
      },
      imageId: asset.id,
      mediaType: asset.mediaType,
      filename: asset.filename,
      size: asset.size,
      url: asset.url,
      ...(asset.vision ? { vision: asset.vision } : {}),
    });
  }
  return content.length === 1 && content[0].type === 'text' ? content[0].text : content;
}

export async function appendUserMessage(history, message, images = []) {
  const content = await buildUserMessageContent(message, images);
  history.push({ role: 'user', content });
  return history.length - 1;
}

export function titleForCompletedTurn({ originalMessageCount, existingTitle, message }) {
  return originalMessageCount === 0 || existingTitle === 'New Chat'
    ? titleFromMessage(message || 'Image chat')
    : undefined;
}

export async function saveCompletedTurn({ conversationId, messages, title }) {
  if (!conversationId) return null;
  return storage.saveConversationUnlocked(conversationId, messages, title);
}
