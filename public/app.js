import { api } from './js/api-client.js';
import { dom } from './js/dom.js';
import { installRendererEventHandlers } from './js/renderers.js';
import { sendMessage } from './js/chat-stream.js';
import { state } from './js/state.js';
import {
  hideChannelEditor,
  hideSettings,
  hideToolRunDetail,
  hydrateAssistantMessages,
  renderChannelList,
  renderConvoList,
  renderMessages,
  renderSelectors,
  renderToolList,
  renderToolRuns,
  scrollBottom,
  showChannelEditor,
  showChannelsPage,
  showChatPage,
  showSettings,
  showToolRunDetail,
  showToolsPageFrame,
} from './js/views.js';

async function loadActive() {
  const data = await api('GET', '/api/v1/active');
  state.channels = data.channels;
  state.activeChannelId = data.activeChannelId;
  state.activeModel = data.activeModel;
  renderSelectors();
}

async function setActiveChannel(channelId) {
  state.activeChannelId = channelId;
  const channel = state.channels.find(item => item.id === channelId);
  if (channel) state.activeModel = channel.models[0] || '';
  await api('POST', '/api/v1/active', { channelId, model: state.activeModel });
  renderSelectors();
}

async function setActiveModel(model) {
  await api('POST', '/api/v1/active', { model });
  state.activeModel = model;
}

async function saveChannel() {
  const id = dom.editChannelId.value;
  const payload = {
    name: dom.editName.value.trim(),
    baseUrl: dom.editBaseUrl.value.trim(),
    apiKey: dom.editApiKey.value.trim(),
    models: dom.editModels.value.split(',').map(item => item.trim()).filter(Boolean),
    maxTokens: parseInt(dom.editMaxTokens.value) || 8192,
  };

  if (!payload.name || !payload.baseUrl) {
    alert('Name and Base URL are required');
    return;
  }

  if (id) {
    const updated = await api('PUT', `/api/v1/channels/${id}`, payload);
    const idx = state.channels.findIndex(channel => channel.id === id);
    if (idx !== -1) state.channels[idx] = updated;
  } else {
    const created = await api('POST', '/api/v1/channels', payload);
    state.channels.push(created);
  }

  const active = await api('GET', '/api/v1/active');
  state.activeChannelId = active.activeChannelId;
  state.activeModel = active.activeModel;
  renderChannelList();
  renderSelectors();
  hideChannelEditor();
}

async function deleteChannel(id) {
  if (!confirm('Delete this channel?')) return;
  await api('DELETE', `/api/v1/channels/${id}`);
  state.channels = state.channels.filter(channel => channel.id !== id);
  const data = await api('GET', '/api/v1/active');
  state.activeChannelId = data.activeChannelId;
  state.activeModel = data.activeModel;
  renderChannelList();
  renderSelectors();
}

async function useChannel(id) {
  await setActiveChannel(id);
  renderChannelList();
  renderSelectors();
}

async function loadTools() {
  state.tools = await api('GET', '/api/v1/tools');
  renderToolList();
}

async function loadToolRuns() {
  state.toolRuns = await api('GET', '/api/v1/tool-runs?limit=20');
  renderToolRuns();
}

async function showToolsPage() {
  showToolsPageFrame();
  await loadTools();
  await loadToolRuns();
}

async function toggleTool(id, enabled) {
  const updated = await api('PUT', `/api/v1/tools/${id}`, { enabled });
  const idx = state.tools.findIndex(tool => tool.id === id);
  if (idx !== -1) state.tools[idx] = updated;
  renderToolList();
}

async function loadConversations() {
  state.conversations = await api('GET', '/api/v1/conversations');
  renderConvoList();
}

async function selectConversation(id) {
  state.activeId = id;
  const convo = await api('GET', `/api/v1/conversations/${id}`);
  state.messages = hydrateAssistantMessages(convo.messages);
  dom.chatTitle.textContent = convo.title;
  renderMessages();
  renderConvoList();
  scrollBottom();
}

async function newConversation() {
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

function bindEvents() {
  installRendererEventHandlers(document);

  dom.btnSend.addEventListener('click', () => sendMessage(dom.msgInput.value));
  dom.msgInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage(dom.msgInput.value);
    }
  });
  dom.msgInput.addEventListener('input', () => {
    dom.msgInput.style.height = 'auto';
    dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 200) + 'px';
  });

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

  dom.logo.addEventListener('click', showChatPage);
  dom.channelSelect.addEventListener('change', () => setActiveChannel(dom.channelSelect.value));
  dom.modelSelect.addEventListener('change', () => setActiveModel(dom.modelSelect.value));

  dom.btnSettings.addEventListener('click', showSettings);
  dom.btnCloseSettings.addEventListener('click', hideSettings);
  dom.settingsModal.querySelector('.modal-backdrop').addEventListener('click', hideSettings);

  dom.settingChannels.addEventListener('click', () => {
    hideSettings();
    showChannelsPage();
  });
  dom.settingTools.addEventListener('click', () => {
    hideSettings();
    showToolsPage();
  });

  dom.btnBackChat.addEventListener('click', showChatPage);
  dom.btnAddChannelPage.addEventListener('click', () => showChannelEditor(null));
  dom.channelList.addEventListener('click', (event) => {
    const card = event.target.closest('.channel-card');
    if (!card) return;
    const id = card.dataset.channelId;
    const btn = event.target.closest('button');
    if (btn) {
      if (btn.dataset.action === 'edit') {
        const channel = state.channels.find(item => item.id === id);
        if (channel) showChannelEditor(channel);
      }
      if (btn.dataset.action === 'delete') deleteChannel(id);
      return;
    }
    if (id !== state.activeChannelId) useChannel(id);
  });
  dom.btnCancelEdit.addEventListener('click', hideChannelEditor);
  dom.btnSaveChannel.addEventListener('click', saveChannel);
  dom.btnToggleKey.addEventListener('click', () => {
    const input = dom.editApiKey;
    if (input.type === 'password') {
      input.type = 'text';
      dom.btnToggleKey.textContent = 'Hide';
    } else {
      input.type = 'password';
      dom.btnToggleKey.textContent = 'Show';
    }
  });

  dom.btnBackChatTools.addEventListener('click', showChatPage);
  dom.btnRefreshTools.addEventListener('click', loadTools);
  dom.btnRefreshToolRuns.addEventListener('click', loadToolRuns);
  dom.toolList.addEventListener('change', (event) => {
    const toggle = event.target.closest('input[data-action="toggle-tool"]');
    if (!toggle) return;
    const card = event.target.closest('.tool-card');
    if (!card) return;
    toggleTool(card.dataset.toolId, toggle.checked).catch(err => {
      alert(err.message);
      toggle.checked = !toggle.checked;
    });
  });

  dom.toolRunList.addEventListener('click', (event) => {
    const item = event.target.closest('.tool-run');
    if (!item) return;
    const run = state.toolRuns[Number(item.dataset.runIndex)];
    if (run) showToolRunDetail(run);
  });
  dom.btnCloseDetail.addEventListener('click', hideToolRunDetail);
  dom.toolRunDetail.querySelector('.detail-backdrop').addEventListener('click', hideToolRunDetail);

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'n') {
      event.preventDefault();
      showChatPage();
      newConversation();
    }
  });
}

async function init() {
  bindEvents();
  await loadActive();
  await loadConversations();
  if (state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id);
  } else {
    renderMessages();
  }
  dom.msgInput.focus();
}

init();
