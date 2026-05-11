// ===== Marked config =====
marked.setOptions({ breaks: true, gfm: true });

// ===== State =====
const state = {
  conversations: [],
  activeId: null,
  messages: [],
  streaming: false,
  channels: [],
  activeChannelId: null,
  activeModel: null,
};

// ===== DOM refs =====
const $ = (sel) => document.querySelector(sel);

const dom = {
  convList: $('#conv-list'),
  messages: $('#messages'),
  chatTitle: $('#chat-title'),
  msgInput: $('#msg-input'),
  btnSend: $('#btn-send'),
  btnNewChat: $('#btn-new-chat'),
  channelSelect: $('#channel-select'),
  modelSelect: $('#model-select'),
  settingsModal: $('#settings-modal'),
  btnSettings: $('#btn-settings'),
  btnCloseSettings: $('#btn-close-settings'),
  settingChannels: $('#setting-channels'),
  logo: $('#logo'),
  chatMain: $('#chat-main'),
  channelsPage: $('#channels-page'),
  btnBackChat: $('#btn-back-chat'),
  channelList: $('#channel-list'),
  btnAddChannelPage: $('#btn-add-channel-page'),
  channelEditor: $('#channel-editor'),
  editorTitle: $('#editor-title'),
  editChannelId: $('#edit-channel-id'),
  editName: $('#edit-name'),
  editBaseUrl: $('#edit-base-url'),
  editApiKey: $('#edit-api-key'),
  editModels: $('#edit-models'),
  editMaxTokens: $('#edit-max-tokens'),
  btnToggleKey: $('#btn-toggle-key'),
  btnCancelEdit: $('#btn-cancel-edit'),
  btnSaveChannel: $('#btn-save-channel'),
};

// ===== API helpers =====
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    let msg = `Error ${res.status}`;
    try { msg = JSON.parse(text).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ===== Active state =====
async function loadActive() {
  const data = await api('GET', '/api/active');
  state.channels = data.channels;
  state.activeChannelId = data.activeChannelId;
  state.activeModel = data.activeModel;
  renderSelectors();
}

async function setActiveChannel(channelId) {
  state.activeChannelId = channelId;
  const ch = state.channels.find(c => c.id === channelId);
  if (ch) state.activeModel = ch.models[0] || '';
  await api('POST', '/api/active', { channelId, model: state.activeModel });
  renderSelectors();
}

async function setActiveModel(model) {
  await api('POST', '/api/active', { model });
  state.activeModel = model;
}

function renderSelectors() {
  dom.channelSelect.innerHTML = state.channels.map(c =>
    `<option value="${c.id}" ${c.id === state.activeChannelId ? 'selected' : ''}>${escHtml(c.name)}</option>`
  ).join('');
  const ch = state.channels.find(c => c.id === state.activeChannelId);
  const models = ch ? ch.models : [];
  if (models.length && !models.includes(state.activeModel)) {
    state.activeModel = models[0];
  }
  dom.modelSelect.innerHTML = models.map(m =>
    `<option value="${m}" ${m === state.activeModel ? 'selected' : ''}>${m}</option>`
  ).join('');
}

// ===== Pages =====
function showChannelsPage() {
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.remove('hidden');
  renderChannelList();
  dom.channelEditor.classList.add('hidden');
}

function hideChannelsPage() {
  dom.channelsPage.classList.add('hidden');
  dom.chatMain.classList.remove('hidden');
}

// ===== Settings modal =====
function showSettings() {
  dom.settingsModal.classList.remove('hidden');
}

function hideSettings() {
  dom.settingsModal.classList.add('hidden');
}

// ===== Channel list (on channels page) =====
function renderChannelList() {
  dom.channelList.innerHTML = state.channels.map(c => `
    <div class="channel-card${c.id === state.activeChannelId ? ' active' : ''}" data-channel-id="${c.id}">
      <div class="ch-info">
        <div class="ch-name">${escHtml(c.name)}</div>
        <div class="ch-meta">${escHtml(c.baseUrl)} · OpenAI Chat · ${c.models.length} models</div>
      </div>
      <span class="ch-badge">openai</span>
      <div class="ch-actions">
        <button data-action="edit" data-id="${c.id}">Edit</button>
        <button data-action="delete" data-id="${c.id}" class="danger" ${state.channels.length <= 1 ? 'disabled' : ''}>Del</button>
      </div>
    </div>
  `).join('');
}

function showChannelEditor(channel) {
  if (channel) {
    dom.editorTitle.textContent = 'Edit Channel';
    dom.editChannelId.value = channel.id;
    dom.editName.value = channel.name || '';
    dom.editBaseUrl.value = channel.baseUrl || '';
    dom.editApiKey.value = channel.apiKey || '';
    dom.editApiKey.type = 'password';
    dom.btnToggleKey.textContent = 'Show';
    dom.editModels.value = (channel.models || []).join(', ');
    dom.editMaxTokens.value = channel.maxTokens || 8192;
  } else {
    dom.editorTitle.textContent = 'New Channel';
    dom.editChannelId.value = '';
    dom.editName.value = '';
    dom.editBaseUrl.value = '';
    dom.editApiKey.value = '';
    dom.editApiKey.type = 'password';
    dom.btnToggleKey.textContent = 'Show';
    dom.editModels.value = '';
    dom.editMaxTokens.value = 8192;
  }
  dom.channelEditor.classList.remove('hidden');
}

function hideChannelEditor() {
  dom.channelEditor.classList.add('hidden');
}

async function saveChannel() {
  const id = dom.editChannelId.value;
  const payload = {
    name: dom.editName.value.trim(),
    baseUrl: dom.editBaseUrl.value.trim(),
    apiKey: dom.editApiKey.value.trim(),
    models: dom.editModels.value.split(',').map(s => s.trim()).filter(Boolean),
    maxTokens: parseInt(dom.editMaxTokens.value) || 8192,
  };

  if (!payload.name || !payload.baseUrl) {
    alert('Name and Base URL are required');
    return;
  }

  if (id) {
    const updated = await api('PUT', `/api/channels/${id}`, payload);
    const idx = state.channels.findIndex(c => c.id === id);
    if (idx !== -1) state.channels[idx] = updated;
  } else {
    const created = await api('POST', '/api/channels', payload);
    state.channels.push(created);
  }

  renderChannelList();
  renderSelectors();
  hideChannelEditor();
}

async function deleteChannel(id) {
  if (state.channels.length <= 1) return;
  if (!confirm('Delete this channel?')) return;
  await api('DELETE', `/api/channels/${id}`);
  state.channels = state.channels.filter(c => c.id !== id);
  const data = await api('GET', '/api/active');
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

// ===== Conversations =====
async function loadConversations() {
  state.conversations = await api('GET', '/api/conversations');
  renderConvoList();
}

function renderConvoList() {
  dom.convList.innerHTML = state.conversations.map(c =>
    `<div class="conv-item${c.id === state.activeId ? ' active' : ''}" data-id="${c.id}">
      <span class="conv-title">${escHtml(c.title)}</span>
      <button class="conv-delete" data-id="${c.id}" title="Delete">×</button>
    </div>`
  ).join('');
}

async function selectConversation(id) {
  state.activeId = id;
  const convo = await api('GET', `/api/conversations/${id}`);
  state.messages = convo.messages;
  dom.chatTitle.textContent = convo.title;
  renderMessages();
  renderConvoList();
  scrollBottom();
}

async function newConversation() {
  const convo = await api('POST', '/api/conversations', { title: 'New Chat' });
  state.conversations.unshift({
    id: convo.id, title: convo.title,
    createdAt: convo.createdAt, updatedAt: convo.updatedAt, messageCount: 0,
  });
  state.messages = [];
  state.activeId = convo.id;
  dom.chatTitle.textContent = convo.title;
  renderMessages();
  renderConvoList();
  dom.msgInput.focus();
}

async function deleteConversation(id) {
  await api('DELETE', `/api/conversations/${id}`);
  if (state.activeId === id) {
    state.activeId = null;
    state.messages = [];
    dom.chatTitle.textContent = '';
    renderMessages();
  }
  state.conversations = state.conversations.filter(c => c.id !== id);
  renderConvoList();
}

// ===== Messages =====
function renderMessages() {
  const visibleMessages = state.messages.filter(isVisibleMessage);
  if (visibleMessages.length === 0) {
    dom.messages.innerHTML = `
      <div class="empty-state">
        <div class="brand">xwork</div>
        <p>Ask anything. Configure channels in Settings to get started.</p>
      </div>`;
  } else {
    dom.messages.innerHTML = visibleMessages.map(m =>
      `<div class="message ${m.role}">
        <div class="role-label">${m.role === 'user' ? 'YOU' : 'ASSISTANT'}</div>
        <div class="content">${renderContent(messageText(m))}</div>
      </div>`
    ).join('');
  }
}

function isVisibleMessage(message) {
  if (message.role === 'tool') return false;
  return messageText(message).trim().length > 0;
}

function messageText(message) {
  const { content } = message;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
    .filter(part => part?.type === 'text')
    .map(part => part.text || '')
    .join('\n')
      : '';
  return message.role === 'assistant' ? stripLeadingNewlines(text) : text;
}

function stripLeadingNewlines(text) {
  return String(text || '').replace(/^\n+/, '');
}

function renderContent(text) {
  return marked.parse(normalizeMarkdownForDisplay(text));
}

function normalizeMarkdownForDisplay(text) {
  const value = String(text || '').replace(/^\n+/, '');
  const match = value.match(/^\s*```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1].replace(/^\n+/, '') : value;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scrollBottom() {
  requestAnimationFrame(() => {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  });
}

// ===== Chat / Streaming =====
function addUserMessage(text) {
  const es = dom.messages.querySelector('.empty-state');
  if (es) dom.messages.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `<div class="role-label">You</div><div class="content">${renderContent(text)}</div>`;
  dom.messages.appendChild(div);
  scrollBottom();
}

function addAssistantPlaceholder() {
  const div = document.createElement('div');
  div.className = 'message assistant streaming';
  div.innerHTML = `<div class="role-label">ASSISTANT</div><div class="content"></div>`;
  dom.messages.appendChild(div);
  scrollBottom();
  return div.querySelector('.content');
}

async function sendMessage(text) {
  if (!text.trim() || state.streaming) return;
  if (!state.activeChannelId) {
    alert('Please configure a channel in Settings first.');
    return;
  }

  const message = text.trim();
  dom.msgInput.value = '';
  dom.msgInput.style.height = 'auto';
  dom.btnSend.disabled = true;
  state.streaming = true;

  addUserMessage(message);

  if (!state.activeId) {
    const convo = await api('POST', '/api/conversations', {
      title: message.slice(0, 50) + (message.length > 50 ? '…' : ''),
    });
    state.activeId = convo.id;
    state.conversations.unshift({
      id: convo.id, title: convo.title,
      createdAt: convo.createdAt, updatedAt: convo.updatedAt, messageCount: 0,
    });
    dom.chatTitle.textContent = convo.title;
    renderConvoList();
  }

  const contentEl = addAssistantPlaceholder();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: state.activeId,
        message,
        channelId: dom.channelSelect.value,
        model: dom.modelSelect.value,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      let errMsg = `Error ${res.status}`;
      try { errMsg = JSON.parse(err).error || errMsg; } catch {}
      throw new Error(errMsg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') continue;
        try {
          const evt = JSON.parse(jsonStr);
          if (evt.type === 'delta') {
            fullText += evt.text;
            contentEl.innerHTML = renderContent(stripLeadingNewlines(fullText));
            scrollBottom();
          } else if (evt.type === 'tool_call') {
            const names = evt.tools.map(t => t.name).join(', ');
            contentEl.innerHTML = renderContent(`${stripLeadingNewlines(fullText)}\n\n[Using tool: ${names}]`);
            scrollBottom();
          } else if (evt.type === 'tool_result') {
            contentEl.innerHTML = renderContent(stripLeadingNewlines(fullText) || 'Processing tool result...');
            scrollBottom();
          } else if (evt.type === 'error') {
            contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(evt.message)}</span>`;
          }
        } catch {}
      }
    }

    const streamingEl = dom.messages.querySelector('.streaming');
    if (streamingEl) streamingEl.classList.remove('streaming');

    state.messages.push({ role: 'user', content: message });
    state.messages.push({ role: 'assistant', content: fullText, model: state.activeModel });

    const conv = state.conversations.find(c => c.id === state.activeId);
    if (conv && (state.messages.length <= 2 || conv.title === 'New Chat')) {
      conv.title = message.slice(0, 50) + (message.length > 50 ? '…' : '');
      dom.chatTitle.textContent = conv.title;
      renderConvoList();
    }
  } catch (err) {
    contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(err.message)}</span>`;
    const streamingEl = dom.messages.querySelector('.streaming');
    if (streamingEl) streamingEl.classList.remove('streaming');
  }

  state.streaming = false;
  dom.btnSend.disabled = false;
  dom.msgInput.focus();
}

// ===== Event handlers =====
dom.btnSend.addEventListener('click', () => sendMessage(dom.msgInput.value));
dom.msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(dom.msgInput.value);
  }
});
dom.msgInput.addEventListener('input', () => {
  dom.msgInput.style.height = 'auto';
  dom.msgInput.style.height = Math.min(dom.msgInput.scrollHeight, 200) + 'px';
});
dom.btnNewChat.addEventListener('click', newConversation);
dom.convList.addEventListener('click', (e) => {
  const item = e.target.closest('.conv-item');
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.closest('.conv-delete')) {
    e.stopPropagation();
    if (confirm('Delete this conversation?')) deleteConversation(id);
    return;
  }
  hideChannelsPage();
  if (id !== state.activeId) selectConversation(id);
});
dom.logo.addEventListener('click', hideChannelsPage);
dom.channelSelect.addEventListener('change', () => setActiveChannel(dom.channelSelect.value));
dom.modelSelect.addEventListener('change', () => setActiveModel(dom.modelSelect.value));

// Settings
dom.btnSettings.addEventListener('click', showSettings);
dom.btnCloseSettings.addEventListener('click', hideSettings);
dom.settingsModal.querySelector('.modal-backdrop').addEventListener('click', hideSettings);

// Settings → Channels page
dom.settingChannels.addEventListener('click', () => {
  hideSettings();
  showChannelsPage();
});

// Channels page
dom.btnBackChat.addEventListener('click', hideChannelsPage);
dom.btnAddChannelPage.addEventListener('click', () => showChannelEditor(null));
dom.channelList.addEventListener('click', (e) => {
  const card = e.target.closest('.channel-card');
  if (!card) return;
  const id = card.dataset.channelId;

  const btn = e.target.closest('button');
  if (btn) {
    if (btn.dataset.action === 'edit') {
      const ch = state.channels.find(c => c.id === id);
      if (ch) showChannelEditor(ch);
    }
    if (btn.dataset.action === 'delete') deleteChannel(id);
    return;
  }

  // Click on card body → activate
  if (id !== state.activeChannelId) useChannel(id);
});
dom.btnCancelEdit.addEventListener('click', hideChannelEditor);
dom.btnSaveChannel.addEventListener('click', saveChannel);
dom.btnToggleKey.addEventListener('click', () => {
  const inp = dom.editApiKey;
  if (inp.type === 'password') {
    inp.type = 'text';
    dom.btnToggleKey.textContent = 'Hide';
  } else {
    inp.type = 'password';
    dom.btnToggleKey.textContent = 'Show';
  }
});

// Ctrl+N new chat
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    hideChannelsPage();
    newConversation();
  }
});

// ===== Init =====
async function init() {
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
