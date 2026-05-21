import * as storage from '../storage.mjs';
import { titleFromMessage } from './message-projector.mjs';

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

export function appendUserMessage(history, message) {
  history.push({ role: 'user', content: message });
  return history.length - 1;
}

export function titleForCompletedTurn({ originalMessageCount, existingTitle, message }) {
  return originalMessageCount === 0 || existingTitle === 'New Chat'
    ? titleFromMessage(message)
    : undefined;
}

export async function saveCompletedTurn({ conversationId, messages, title }) {
  if (!conversationId) return null;
  return storage.saveConversationUnlocked(conversationId, messages, title);
}
