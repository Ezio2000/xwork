import { api } from '../api-client.js';
import { renderActiveStreamingMessage } from '../chat-stream.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import {
  hydrateAssistantMessages,
  renderConvoList,
  renderMessages,
  scrollBottom,
  showChatPage,
} from '../views.js';

export async function loadConversations() {
  state.conversations = await api('GET', '/api/v1/conversations');
  renderConvoList();
}

export async function selectConversation(id) {
  state.activeId = id;
  const convo = await api('GET', `/api/v1/conversations/${id}`);
  state.messages = hydrateAssistantMessages(convo.messages);
  dom.chatTitle.textContent = convo.title;
  renderMessages();
  renderActiveStreamingMessage();
  renderConvoList();
  scrollBottom();
}

export async function newConversation() {
  const convo = await api('POST', '/api/v1/conversations', { title: 'New Chat' });
  state.conversations.unshift({
    id: convo.id,
    title: convo.title,
    createdAt: convo.createdAt,
    updatedAt: convo.updatedAt,
    messageCount: 0,
  });
  state.messages = [];
  state.activeId = convo.id;
  dom.chatTitle.textContent = convo.title;
  renderMessages();
  renderConvoList();
  dom.msgInput.focus();
}

async function deleteConversation(id) {
  await api('DELETE', `/api/v1/conversations/${id}`);
  if (state.activeId === id) {
    state.activeId = null;
    state.messages = [];
    dom.chatTitle.textContent = '';
    renderMessages();
  }
  state.conversations = state.conversations.filter(conversation => conversation.id !== id);
  renderConvoList();
}

export function bindConversationsController() {
  dom.btnNewChat.addEventListener('click', newConversation);

  dom.convList.addEventListener('click', (event) => {
    const item = event.target.closest('.conv-item');
    if (!item) return;
    const id = item.dataset.id;
    if (event.target.closest('.conv-delete')) {
      event.stopPropagation();
      deleteConversation(id);
      return;
    }
    showChatPage();
    if (id !== state.activeId) selectConversation(id);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'n') {
      event.preventDefault();
      showChatPage();
      newConversation();
    }
  });
}
