import { state } from '../state.js';

export function getActiveConversationId() {
  return state.activeId;
}

export function isActiveConversation(conversationId) {
  return state.activeId === conversationId;
}

export function getActiveStream() {
  return state.activeId ? state.streamingByConversationId.get(state.activeId) : null;
}
