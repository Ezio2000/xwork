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
  tools: [],
  toolRuns: [],
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
  settingTools: $('#setting-tools'),
  logo: $('#logo'),
  chatMain: $('#chat-main'),
  channelsPage: $('#channels-page'),
  toolsPage: $('#tools-page'),
  btnBackChat: $('#btn-back-chat'),
  btnBackChatTools: $('#btn-back-chat-tools'),
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
  btnRefreshTools: $('#btn-refresh-tools'),
  btnRefreshToolRuns: $('#btn-refresh-tool-runs'),
  toolList: $('#tool-list'),
  toolRunList: $('#tool-run-list'),
  btnCloseDetail: $('#btn-close-detail'),
  toolRunDetail: $('#tool-run-detail'),
  detailTitle: $('#detail-title'),
  detailBody: $('#detail-body'),
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
  const data = await api('GET', '/api/v1/active');
  state.channels = data.channels;
  state.activeChannelId = data.activeChannelId;
  state.activeModel = data.activeModel;
  renderSelectors();
}

async function setActiveChannel(channelId) {
  state.activeChannelId = channelId;
  const ch = state.channels.find(c => c.id === channelId);
  if (ch) state.activeModel = ch.models[0] || '';
  await api('POST', '/api/v1/active', { channelId, model: state.activeModel });
  renderSelectors();
}

async function setActiveModel(model) {
  await api('POST', '/api/v1/active', { model });
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
  dom.toolsPage.classList.add('hidden');
  dom.channelsPage.classList.remove('hidden');
  renderChannelList();
  dom.channelEditor.classList.add('hidden');
}

function hideChannelsPage() {
  dom.channelsPage.classList.add('hidden');
  dom.chatMain.classList.remove('hidden');
}

async function showToolsPage() {
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.remove('hidden');
  await loadTools();
  await loadToolRuns();
}

function hideToolsPage() {
  dom.toolsPage.classList.add('hidden');
  dom.chatMain.classList.remove('hidden');
}

function showChatPage() {
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
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
        <div class="ch-meta">${escHtml(c.baseUrl)} · Anthropic Messages · ${c.models.length} models</div>
      </div>
      <span class="ch-badge">anthropic</span>
      <div class="ch-actions">
        <button data-action="edit" data-id="${c.id}">Edit</button>
        <button data-action="delete" data-id="${c.id}" class="danger">Del</button>
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
    dom.editBaseUrl.value = 'https://api.deepseek.com/anthropic';
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
    const updated = await api('PUT', `/api/v1/channels/${id}`, payload);
    const idx = state.channels.findIndex(c => c.id === id);
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
  state.channels = state.channels.filter(c => c.id !== id);
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

// ===== Tool list (on tools page) =====
async function loadTools() {
  state.tools = await api('GET', '/api/v1/tools');
  renderToolList();
}

async function loadToolRuns() {
  state.toolRuns = await api('GET', '/api/v1/tool-runs?limit=20');
  renderToolRuns();
}

function renderToolList() {
  if (!state.tools.length) {
    dom.toolList.innerHTML = '<div class="empty-panel">No tools available.</div>';
    return;
  }

  dom.toolList.innerHTML = state.tools.map(tool => `
    <div class="tool-card${tool.enabled ? ' enabled' : ''}" data-tool-id="${escHtml(tool.id)}">
      <div class="tool-info">
        <div class="tool-title-row">
          <div class="tool-title">${escHtml(tool.title || tool.name)}</div>
          <span class="tool-status">${tool.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div class="tool-desc">${escHtml(tool.description || '')}</div>
        <div class="tool-meta">
          <span>${escHtml(tool.name)}</span>
          <span>${escHtml(tool.adapter || 'builtin')}</span>
          <span>${escHtml(tool.category || 'general')}</span>
          <span>${Number(tool.timeoutMs || 0)}ms</span>
        </div>
      </div>
      <label class="switch" title="Toggle tool">
        <input type="checkbox" data-action="toggle-tool" ${tool.enabled ? 'checked' : ''}>
        <span></span>
      </label>
    </div>
  `).join('');
}

function renderToolRuns() {
  if (!state.toolRuns.length) {
    dom.toolRunList.innerHTML = '<div class="empty-panel">No tool runs yet.</div>';
    return;
  }

  dom.toolRunList.innerHTML = state.toolRuns.map((run, i) => `
    <div class="tool-run${run.isError ? ' error' : ''}" data-run-index="${i}">
      <div class="tool-run-main">
        <span class="tool-run-name">${escHtml(run.name || '')}</span>
        <span class="tool-run-status">${run.isError ? 'Error' : 'OK'}</span>
      </div>
      <div class="tool-run-meta">
        ${Number(run.durationMs || 0)}ms · ${escHtml(formatDateTime(run.createdAt))}
      </div>
    </div>
  `).join('');
}

function showToolRunDetail(run) {
  dom.detailTitle.textContent = run.name || 'Tool Run';
  const parts = [];

  // Status + duration
  parts.push(`
    <div class="detail-section">
      <div class="detail-meta-grid">
        <div class="detail-meta-item">
          <div class="dm-label">Status</div>
          <div class="dm-value" style="color:${run.isError ? 'var(--danger)' : 'var(--accent)'}">${run.isError ? 'Error' : 'OK'}</div>
        </div>
        <div class="detail-meta-item">
          <div class="dm-label">Duration</div>
          <div class="dm-value">${Number(run.durationMs || 0)}ms</div>
        </div>
        <div class="detail-meta-item">
          <div class="dm-label">Time</div>
          <div class="dm-value">${escHtml(formatDateTime(run.createdAt))}</div>
        </div>
        <div class="detail-meta-item">
          <div class="dm-label">Run ID</div>
          <div class="dm-value" style="font-size:11px">${escHtml(run.runId || '')}</div>
        </div>
      </div>
    </div>
  `);

  // Error info
  if (run.isError || run.output?.errorCode || run.output?.errors?.length) {
    const errorMsg = run.output?.errors?.join(', ') || run.output?.errorCode || String(run.output || 'Unknown error');
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Error</div>
        <div class="detail-error">${escHtml(errorMsg)}</div>
      </div>
    `);
  }

  // Input
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Input</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.input || {}, null, 2))}</pre></div>
    </div>
  `);

  // Output (non-source)
  if (run.output?.sources?.length) {
    // source-cards renderType
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Sources (${run.output.sources.length})</div>
        <div class="detail-sources">
          ${run.output.sources.map(s => `
            <div class="detail-source">
              <div class="ds-title">${escHtml(s.title || 'Untitled')}</div>
              ${s.url ? `<a class="ds-url" href="${escHtml(s.url)}" target="_blank" rel="noreferrer">${escHtml(s.url)}</a>` : ''}
              ${s.snippet ? `<div class="ds-snippet">${escHtml(s.snippet)}</div>` : ''}
              ${s.pageAge ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">${escHtml(s.pageAge)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `);
  } else if (run.output?.resultCount !== undefined) {
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Output</div>
        <div class="detail-value">${run.output.resultCount} result(s)</div>
      </div>
    `);
  } else if (run.output && !run.output.sources) {
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Output</div>
        <div class="detail-value"><pre>${escHtml(JSON.stringify(run.output, null, 2))}</pre></div>
      </div>
    `);
  }



  // Context
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Context</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.context || {}, null, 2))}</pre></div>
    </div>
  `);

  dom.detailBody.innerHTML = parts.join('');
  dom.toolRunDetail.classList.remove('hidden');
}

function hideToolRunDetail() {
  dom.toolRunDetail.classList.add('hidden');
}

async function toggleTool(id, enabled) {
  const updated = await api('PUT', `/api/v1/tools/${id}`, { enabled });
  const idx = state.tools.findIndex(tool => tool.id === id);
  if (idx !== -1) state.tools[idx] = updated;
  renderToolList();
}

// ===== Conversations =====
async function loadConversations() {
  state.conversations = await api('GET', '/api/v1/conversations');
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

function contentToBlocks(content, sourcesMeta, searchCountMeta, toolResultsMap) {
  // Convert Anthropic content array (text + tool_result blocks) into ordered blocks
  if (!Array.isArray(content)) return null;

  const blocks = [];
  let textBuf = '';

  function flushText() {
    const t = stripLeadingNewlines(stripSearchQueryText(textBuf));
    if (t) blocks.push({ type: 'text', content: t });
    textBuf = '';
  }

  for (const part of content) {
    if (part.type === 'text') {
      textBuf += (textBuf ? '\n' : '') + (part.text || '');
    } else if (part.type === 'web_search_tool_result') {
      flushText();
      const items = Array.isArray(part.content) ? part.content : [];
      const sources = items
        .filter(item => item?.type === 'web_search_result')
        .map(item => ({
          title: item.title || '',
          url: item.url || '',
          pageAge: item.page_age || item.pageAge || '',
          snippet: item.snippet || item.description || item.text || '',
        }))
        .filter(s => s.title || s.url);
      if (sources.length) {
        blocks.push({ type: 'sources', sources, searchCount: 1 });
      }
    } else if (part.type === 'tool_result' && typeof part.content === 'string') {
      flushText();
      try {
        const data = JSON.parse(part.content);
        if (Array.isArray(data.uuids)) {
          blocks.push({ type: 'uuid-list', uuids: data.uuids, count: data.count ?? data.uuids.length });
        }
      } catch {}
    } else if (part.type === 'tool_use' || part.type === 'server_tool_use') {
      flushText();
      if (toolResultsMap) {
        const tr = toolResultsMap[part.id || part.tool_use_id];
        if (tr?.type === 'uuid-list') {
          blocks.push(tr);
          blocks.push({ type: 'text', content: '' });
        }
      }
    }
  }
  flushText();

  // If no tool_result in content but message has sources metadata, append at end
  if (!blocks.some(b => b.type === 'sources')) {
    const srcs = Array.isArray(sourcesMeta) ? sourcesMeta : [];
    if (srcs.length && blocks.length) {
      blocks.push({ type: 'sources', sources: srcs, searchCount: searchCountMeta || 0 });
    }
  }

  return blocks.length ? blocks : null;
}

async function selectConversation(id) {
  state.activeId = id;
  const convo = await api('GET', `/api/v1/conversations/${id}`);

  // Pre-scan: build tool result maps for each assistant message
  // Maps tool_use_id → { type: 'uuid-list', uuids, count }
  const toolResultsByAssistant = {};
  for (let i = 0; i < convo.messages.length; i++) {
    const msg = convo.messages[i];
    if (msg.role !== 'assistant') continue;
    const map = {};
    for (let j = i + 1; j < convo.messages.length; j++) {
      const next = convo.messages[j];
      if (next.role !== 'user') break;
      if (!Array.isArray(next.content)) continue;
      for (const part of next.content) {
        if (part.type === 'tool_result' && typeof part.content === 'string') {
          try {
            const data = JSON.parse(part.content);
            if (Array.isArray(data.uuids)) {
              map[part.tool_use_id] = { type: 'uuid-list', uuids: data.uuids, count: data.count ?? data.uuids.length };
            }
          } catch {}
        }
      }
    }
    if (Object.keys(map).length) {
      toolResultsByAssistant[i] = map;
    }
  }

  state.messages = convo.messages.map((m, i) => {
    if (m.role === 'assistant') {
      const toolMap = toolResultsByAssistant[i];
      if (Array.isArray(m.blocks)) {
        if (toolMap && !m.blocks.some(b => b.type === 'uuid-list')) {
          const blocks = contentToBlocks(m.content, m.sources, m.searchCount, toolMap);
          if (blocks) return { ...m, blocks };
        }
        return m;
      }
      const blocks = contentToBlocks(m.content, m.sources, m.searchCount, toolMap);
      if (blocks) return { ...m, blocks };
    }
    return m;
  });

  // Fix: move uuid-list before the last contentful text if misplaced
  // (covers old conversations saved before server-side position fix)
  for (const msg of state.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.blocks)) continue;
    let lastTextIdx = -1;
    let firstPostTextUuid = -1;
    for (let i = 0; i < msg.blocks.length; i++) {
      const b = msg.blocks[i];
      if (b.type === 'text' && b.content?.trim()) lastTextIdx = i;
      if (b.type === 'uuid-list' && lastTextIdx >= 0 && firstPostTextUuid < 0) firstPostTextUuid = i;
    }
    if (firstPostTextUuid < 0) continue;
    const before = msg.blocks.slice(0, lastTextIdx);
    const uuids = msg.blocks.filter(b => b.type === 'uuid-list');
    const after = msg.blocks.slice(lastTextIdx).filter(b => b.type !== 'uuid-list');
    msg.blocks = [...before, ...uuids, ...after];
  }

  dom.chatTitle.textContent = convo.title;
  renderMessages();
  renderConvoList();
  scrollBottom();
}

async function newConversation() {
  const convo = await api('POST', '/api/v1/conversations', { title: 'New Chat' });
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
  await api('DELETE', `/api/v1/conversations/${id}`);
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
    dom.messages.innerHTML = visibleMessages.map(m => {
      if (m.role === 'assistant' && Array.isArray(m.blocks)) {
        return `<div class="message assistant">
          <div class="role-label">ASSISTANT</div>
          <div class="content">${renderBlocks(m.blocks, true)}</div>
        </div>`;
      }
      return `<div class="message ${m.role}">
        <div class="role-label">${m.role === 'user' ? 'YOU' : 'ASSISTANT'}</div>
        <div class="content">${renderContent(messageText(m))}</div>
        ${m.role === 'assistant' ? `<div class="web-sources">${renderSourceCards(messageSources(m), true, m.searchCount || 0)}</div>` : ''}
      </div>`;
    }).join('');
  }
}

function isVisibleMessage(message) {
  if (message.role === 'tool') return false;
  return messageText(message).trim().length > 0;
}

function stripSearchQueryText(text) {
  return String(text || '').replace(/^Search results for query: .*/gm, '').replace(/\n{3,}/g, '\n\n');
}

function messageText(message) {
  // blocks format (new): extract text from blocks array
  if (Array.isArray(message.blocks)) {
    const text = message.blocks
      .filter(b => b.type === 'text')
      .map(b => b.content || '')
      .join('\n');
    return message.role === 'assistant' ? stripLeadingNewlines(stripSearchQueryText(text)) : text;
  }
  const { content } = message;
  if (typeof content === 'string') {
    return message.role === 'assistant' ? stripLeadingNewlines(stripSearchQueryText(content)) : content;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter(part => part?.type === 'text' && !part.text?.startsWith('Search results for query:'))
      .map(part => part.text || '')
      .join('\n');
    return message.role === 'assistant' ? stripLeadingNewlines(text) : text;
  }
  return '';
}

function messageSources(message) {
  if (Array.isArray(message.blocks)) {
    return message.blocks
      .filter(b => b.type === 'sources')
      .flatMap(b => b.sources || []);
  }
  return Array.isArray(message?.sources) ? message.sources : [];
}

function messageSearchCount(message) {
  if (Array.isArray(message.blocks)) {
    return message.blocks.reduce((sum, b) => sum + (b.type === 'sources' ? (b.searchCount || 0) : 0), 0);
  }
  return message.searchCount || 0;
}

function renderBlocks(blocks, collapsed) {
  if (!blocks?.length) return '';
  return blocks.map(block => {
    if (block.type === 'text') {
      return renderContent(stripLeadingNewlines(stripSearchQueryText(block.content || '')));
    }
    if (block.type === 'sources') {
      return renderSourceCards(block.sources || [], collapsed, block.searchCount || 0);
    }
    if (block.type === 'uuid-list') {
      return renderUuidList(block.uuids || [], block.count || 0);
    }
    return '';
  }).join('');
}

function stripLeadingNewlines(text) {
  return String(text || '').replace(/^\n+/, '');
}

function renderMath(text) {
  let value = String(text || '');
  const displayMath = [];
  value = value.replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => {
    try {
      displayMath.push(katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false }));
    } catch {
      displayMath.push(`<code>$${escHtml(formula)}$$</code>`);
    }
    return `\x00DM${displayMath.length - 1}\x00`;
  });
  const inlineMath = [];
  value = value.replace(/\$(.+?)\$/g, (_, formula) => {
    try {
      inlineMath.push(katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false }));
    } catch {
      inlineMath.push(`<code>$${escHtml(formula)}$</code>`);
    }
    return `\x00IM${inlineMath.length - 1}\x00`;
  });
  return { value, displayMath, inlineMath };
}

function renderContent(text) {
  const { value, displayMath, inlineMath } = renderMath(text);
  let html = marked.parse(normalizeMarkdownForDisplay(value));
  html = html.replace(/\x00DM(\d+)\x00/g, (_, i) => displayMath[+i]);
  html = html.replace(/\x00IM(\d+)\x00/g, (_, i) => inlineMath[+i]);
  return html;
}

function normalizeMarkdownForDisplay(text) {
  let value = String(text || '').replace(/^\n+/, '');
  // Insert zero-width space between CJK char and ** or * markers
  // so CommonMark can recognize the delimiter (CJK chars are not valid delimiter boundaries)
  value = value.replace(/([一-鿿　-〿＀-￯])(\*{1,2})/g, '$1​$2');
  value = value.replace(/(\*{1,2})([一-鿿　-〿＀-￯])/g, '$1​$2');
  const match = value.match(/^\s*```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1].replace(/^\n+/, '') : value;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function sourceHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sourceMeta(source) {
  return [sourceHost(source.url), source.pageAge].filter(Boolean).join(' · ');
}

function mergeSources(existing, incoming) {
  const out = [...existing];
  const seen = new Set(out.map(source => source.url || `${source.title}|${source.pageAge}`));
  for (const source of incoming || []) {
    if (!source || (!source.title && !source.url)) continue;
    const key = source.url || `${source.title}|${source.pageAge}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

function renderSourceCards(sources, collapsed = false, searchCount = 0) {
  if (!sources?.length) return '';
  const label = searchCount > 0
    ? `${searchCount} search${searchCount > 1 ? 'es' : ''} · ${sources.length} result${sources.length !== 1 ? 's' : ''}`
    : `${sources.length} result${sources.length !== 1 ? 's' : ''}`;
  return `
    <div class="sources-toggle${collapsed ? ' collapsed' : ''}">
      <div class="sources-toggle-header" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="sources-toggle-label">${escHtml(label)}</span>
        <span class="sources-toggle-arrow">▾</span>
      </div>
      <div class="sources-toggle-body">
        <div class="source-list" aria-label="Web search sources">
          ${sources.map((source, index) => `
            <a class="source-card" href="${escHtml(source.url || '#')}" target="_blank" rel="noreferrer">
              <span class="source-index">${index + 1}</span>
              <span class="source-body">
                <span class="source-title">${escHtml(source.title || source.url || 'Untitled source')}</span>
                <span class="source-meta">${escHtml(sourceMeta(source))}</span>
              </span>
            </a>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderSourcesInto(el, sources, searchCount = 0) {
  if (!el) return;
  el.innerHTML = renderSourceCards(sources, false, searchCount);
}

function renderUuidList(uuids, count) {
  if (!uuids?.length) return '';
  const label = count === 1 ? 'UUID' : `${count} UUIDs`;
  return `
    <div class="uuid-toggle collapsed">
      <div class="uuid-toggle-header" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="uuid-toggle-label">${label}</span>
        <span class="uuid-toggle-arrow">▾</span>
      </div>
      <div class="uuid-toggle-body">
        <div class="uuid-list-container">
          <div class="uuid-list-header">
            <button class="uuid-copy-all" onclick="copyUuids(event, this)" data-uuids="${escHtml(JSON.stringify(uuids))}">Copy all</button>
          </div>
          <div class="uuid-list">
            ${uuids.map((uuid, i) => `
              <div class="uuid-row">
                <span class="uuid-index">${i + 1}</span>
                <code class="uuid-value">${escHtml(uuid)}</code>
                <button class="uuid-copy-one" onclick="copyUuid(event, '${escHtml(uuid)}')" title="Copy">Copy</button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function copyUuid(event, uuid) {
  event.preventDefault();
  navigator.clipboard.writeText(uuid).then(() => {
    const btn = event.currentTarget;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  }).catch(() => {});
}

function copyUuids(event, btn) {
  event.preventDefault();
  try {
    const uuids = JSON.parse(btn.dataset.uuids);
    navigator.clipboard.writeText(uuids.join('\n')).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy all'; }, 1200);
    }).catch(() => {});
  } catch {}
}

function scrollBottom() {
  requestAnimationFrame(() => {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  });
}

// ===== Thinking popup =====
let thinkingPopup = null;
let thinkingPopupTimer = null;

function ensureThinkingPopup() {
  if (thinkingPopup) return thinkingPopup;
  thinkingPopup = document.createElement('div');
  thinkingPopup.id = 'thinking-popup';
  thinkingPopup.className = 'hidden';
  thinkingPopup.innerHTML = '<div class="thinking-popup-content"></div>';
  document.body.appendChild(thinkingPopup);
  return thinkingPopup;
}

function showThinkingPopup(text) {
  const popup = ensureThinkingPopup();
  const contentEl = popup.querySelector('.thinking-popup-content');
  popup.classList.remove('hidden');
  contentEl.textContent = text;
  contentEl.scrollTop = contentEl.scrollHeight;
  clearTimeout(thinkingPopupTimer);
}

function hideThinkingPopup() {
  if (!thinkingPopup) return;
  thinkingPopup.classList.add('hidden');
  clearTimeout(thinkingPopupTimer);
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
  return {
    rootEl: div,
    contentEl: div.querySelector('.content'),
  };
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
    const convo = await api('POST', '/api/v1/conversations', {
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

  const assistantView = addAssistantPlaceholder();
  const { contentEl } = assistantView;

  try {
    const res = await fetch('/api/v1/chat', {
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

    // blocks: ordered stream of {type:'text',content} | {type:'sources',sources,searchCount}
    let blocks = [{ type: 'text', content: '' }];
    let totalSearchCount = 0;

    function currentTextBlock() {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === 'text') return blocks[i];
      }
      const b = { type: 'text', content: '' };
      blocks.push(b);
      return b;
    }

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
          if (evt.type === 'thinking') {
            showThinkingPopup(evt.text);
          } else if (evt.type === 'delta') {
            hideThinkingPopup();
            currentTextBlock().content += evt.text;
            contentEl.innerHTML = renderBlocks(blocks, false);
            scrollBottom();
          } else if (evt.type === 'tool_call') {
            // Sources cards from tool_result already indicate tool activity
            contentEl.innerHTML = renderBlocks(blocks, false);
            scrollBottom();
          } else if (evt.type === 'tool_result') {
            let hasSources = false;
            for (const tool of evt.tools) {
              if (tool.renderType === 'source-cards' && tool.data?.sources?.length) {
                totalSearchCount++;
                hasSources = true;
                blocks.push({ type: 'sources', sources: tool.data.sources, searchCount: 1 });
              }
              if (tool.renderType === 'uuid-list' && tool.data?.uuids?.length) {
                blocks.push({ type: 'uuid-list', uuids: tool.data.uuids, count: tool.data.count });
              }
            }
            const errored = evt.tools.filter(tool => tool.isError).map(tool => tool.name).join(', ');
            if (errored) {
              currentTextBlock().content += `\n\n_Tool error: ${errored}_`;
            }
            // Don't add placeholder status — [Using tool: ...] already shows progress
            blocks.push({ type: 'text', content: '' });
            contentEl.innerHTML = renderBlocks(blocks, false);
            scrollBottom();
          } else if (evt.type === 'error') {
            contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(evt.message)}</span>`;
          }
        } catch {}
      }
    }

    hideThinkingPopup();
    const streamingEl = dom.messages.querySelector('.streaming');
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      streamingEl.querySelectorAll('.sources-toggle').forEach(t => t.classList.add('collapsed'));
    }

    // Dedup sources across blocks for backwards compat
    const allSources = blocks
      .filter(b => b.type === 'sources')
      .flatMap(b => b.sources || [])
      .reduce((acc, s) => mergeSources(acc, [s]), []);

    state.messages.push({ role: 'user', content: message });
    state.messages.push({ role: 'assistant', blocks, model: state.activeModel, sources: allSources, searchCount: totalSearchCount });

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
    deleteConversation(id);
    return;
  }
  showChatPage();
  if (id !== state.activeId) selectConversation(id);
});
dom.logo.addEventListener('click', showChatPage);
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
dom.settingTools.addEventListener('click', () => {
  hideSettings();
  showToolsPage();
});

// Channels page
dom.btnBackChat.addEventListener('click', showChatPage);
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

// Tools page
dom.btnBackChatTools.addEventListener('click', showChatPage);
dom.btnRefreshTools.addEventListener('click', loadTools);
dom.btnRefreshToolRuns.addEventListener('click', loadToolRuns);
dom.toolList.addEventListener('change', (e) => {
  const toggle = e.target.closest('input[data-action="toggle-tool"]');
  if (!toggle) return;
  const card = e.target.closest('.tool-card');
  if (!card) return;
  toggleTool(card.dataset.toolId, toggle.checked).catch(err => {
    alert(err.message);
    toggle.checked = !toggle.checked;
  });
});

dom.toolRunList.addEventListener('click', (e) => {
  const item = e.target.closest('.tool-run');
  if (!item) return;
  const idx = Number(item.dataset.runIndex);
  const run = state.toolRuns[idx];
  if (run) showToolRunDetail(run);
});

dom.btnCloseDetail.addEventListener('click', hideToolRunDetail);
dom.toolRunDetail.querySelector('.detail-backdrop').addEventListener('click', hideToolRunDetail);

// Ctrl+N new chat
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    showChatPage();
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
