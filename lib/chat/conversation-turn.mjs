import * as storage from '../storage.mjs';
import { titleFromMessage } from './message-projector.mjs';
import { requireImageAsset } from '../image-assets.mjs';

export async function loadConversationState(conversationId) {
  let history = [];
  let existingTitle = '';
  let originalMessageCount = 0;

  if (conversationId) {
    const convo = await storage.getConversation(conversationId);
    if (convo) {
      history = convo.messages;
      existingTitle = convo.title || '';
      originalMessageCount = history.length;
    }
  }

  return { history, existingTitle, originalMessageCount };
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
