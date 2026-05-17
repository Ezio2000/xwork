import { dom } from './dom.js';
import { state } from './state.js';
import { contentToBlocks, escHtml, formatDateTime, messageSources, messageText, renderBlocks, renderContent, renderSourceCards } from './renderers.js';

export function scrollBottom() {
  requestAnimationFrame(() => {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  });
}

export function renderSelectors() {
  dom.channelSelect.innerHTML = state.channels.map(channel =>
    `<option value="${channel.id}" ${channel.id === state.activeChannelId ? 'selected' : ''}>${escHtml(channel.name)}</option>`
  ).join('');

  const channel = state.channels.find(item => item.id === state.activeChannelId);
  const models = channel ? channel.models : [];
  if (models.length && !models.includes(state.activeModel)) {
    state.activeModel = models[0];
  }
  dom.modelSelect.innerHTML = models.map(model =>
    `<option value="${model}" ${model === state.activeModel ? 'selected' : ''}>${model}</option>`
  ).join('');
}

export function showChannelsPage() {
  hideUsageRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.channelsPage.classList.remove('hidden');
  renderChannelList();
  dom.channelEditor.classList.add('hidden');
}

export function showToolsPageFrame() {
  hideUsageRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.remove('hidden');
  dom.usagePage.classList.add('hidden');
}

export function showUsagePageFrame() {
  hideToolRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.remove('hidden');
}

export function showChatPage() {
  hideToolRunDetail();
  hideUsageRunDetail();
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.chatMain.classList.remove('hidden');
}

export function showSettings() {
  dom.settingsModal.classList.remove('hidden');
}

export function hideSettings() {
  dom.settingsModal.classList.add('hidden');
}

export function renderChannelList() {
  dom.channelList.innerHTML = state.channels.map(channel => `
    <div class="channel-card${channel.id === state.activeChannelId ? ' active' : ''}" data-channel-id="${channel.id}">
      <div class="ch-info">
        <div class="ch-name">${escHtml(channel.name)}</div>
        <div class="ch-meta">${escHtml(channel.baseUrl)} · Anthropic Messages · ${channel.models.length} models</div>
      </div>
      <span class="ch-badge">anthropic</span>
      <div class="ch-actions">
        <button data-action="edit" data-id="${channel.id}">Edit</button>
        <button data-action="delete" data-id="${channel.id}" class="danger">Del</button>
      </div>
    </div>
  `).join('');
}

export function showChannelEditor(channel) {
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

export function hideChannelEditor() {
  dom.channelEditor.classList.add('hidden');
}

export function renderToolList() {
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

export function renderToolRuns() {
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

export function showToolRunDetail(run) {
  dom.detailTitle.textContent = run.name || 'Tool Run';
  const parts = [];

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

  if (run.isError || run.output?.errorCode || run.output?.errors?.length) {
    const errorMsg = run.output?.errors?.join(', ') || run.output?.errorCode || String(run.output || 'Unknown error');
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Error</div>
        <div class="detail-error">${escHtml(errorMsg)}</div>
      </div>
    `);
  }

  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Input</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.input || {}, null, 2))}</pre></div>
    </div>
  `);

  if (run.output?.sources?.length) {
    parts.push(`
      <div class="detail-section">
        <div class="detail-label">Sources (${run.output.sources.length})</div>
        <div class="detail-sources">
          ${run.output.sources.map(source => `
            <div class="detail-source">
              <div class="ds-title">${escHtml(source.title || 'Untitled')}</div>
              ${source.url ? `<a class="ds-url" href="${escHtml(source.url)}" target="_blank" rel="noreferrer">${escHtml(source.url)}</a>` : ''}
              ${source.snippet ? `<div class="ds-snippet">${escHtml(source.snippet)}</div>` : ''}
              ${source.pageAge ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">${escHtml(source.pageAge)}</div>` : ''}
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

  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Context</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.context || {}, null, 2))}</pre></div>
    </div>
  `);

  dom.detailBody.innerHTML = parts.join('');
  dom.toolRunDetail.classList.remove('hidden');
}

export function hideToolRunDetail() {
  dom.toolRunDetail.classList.add('hidden');
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function fmtPercent(value) {
  return value === null || value === undefined ? '-' : `${Math.round(Number(value) * 1000) / 10}%`;
}

function fmtDuration(value) {
  if (value === null || value === undefined) return '-';
  const n = Number(value || 0);
  return n >= 1000 ? `${Math.round(n / 100) / 10}s` : `${Math.round(n)}ms`;
}

function fmtDate(value) {
  return formatDateTime(value) || '-';
}

function metricCard(label, value, hint = '') {
  return `
    <div class="usage-metric">
      <div class="usage-metric-label">${escHtml(label)}</div>
      <div class="usage-metric-value">${escHtml(value)}</div>
      ${hint ? `<div class="usage-metric-hint">${escHtml(hint)}</div>` : ''}
    </div>
  `;
}

function usageBar(ratio) {
  const pct = Math.max(0, Math.min(100, Number(ratio || 0) * 100));
  const hue = Math.round((pct / 100) * 120);
  return `
    <div class="usage-cache-bar">
      <span style="width:${pct}%;background-color:hsl(${hue} 65% 42%)"></span>
    </div>
  `;
}

function metricBadges(metrics = {}, extras = {}) {
  return [
    `${fmtNumber(metrics.totalInputTokens)} in`,
    `${fmtNumber(metrics.cacheReadInputTokens)} cached`,
    `${fmtNumber(metrics.uncachedInputTokens)} uncached`,
    `${fmtNumber(metrics.outputTokens)} out`,
    `${fmtNumber(metrics.webSearchRequests)} web`,
    extras.toolCalls !== undefined ? `${fmtNumber(extras.toolCalls)} tools` : '',
    extras.subagents ? `${fmtNumber(extras.subagents)} subagents` : '',
  ].filter(Boolean).map(item => `<span>${escHtml(item)}</span>`).join('');
}

function renderUsageRunLine(run) {
  return `
    <div class="usage-run-line" data-run-id="${escHtml(run.runId)}">
      <div class="usage-run-line-main">
        <div class="usage-run-title">
          <span class="usage-role ${escHtml(run.role)}">${escHtml(run.role)}</span>
          <span>${escHtml(run.label || run.task || run.runId)}</span>
        </div>
        <div class="usage-run-cache">${fmtPercent(run.metrics?.cacheHitRatio)}</div>
      </div>
      <div class="usage-run-meta">
        <span>${escHtml(run.model || 'unknown')}</span>
        <span>${fmtDuration(run.durationMs)}</span>
        ${metricBadges(run.metrics, { toolCalls: run.toolCounts?.totalToolCalls })}
      </div>
      ${usageBar(run.metrics?.cacheHitRatio)}
    </div>
  `;
}

function renderUsageTask(task, index) {
  const metrics = task.metrics || {};
  const expanded = Boolean(task.expanded);
  return `
    <div class="usage-task${expanded ? ' expanded' : ''}" data-task-index="${index}">
      <div class="usage-task-summary" data-action="toggle-usage-task">
        <div class="usage-run-main">
          <div class="usage-run-title">
            <span class="usage-task-arrow">${expanded ? '▾' : '▸'}</span>
            <span class="usage-role root">task</span>
            <span>${escHtml(task.label || task.task || task.rootRunId)}</span>
          </div>
          <div class="usage-run-cache">${fmtPercent(metrics.cacheHitRatio)}</div>
        </div>
        <div class="usage-run-meta">
          <span>${escHtml(task.model || 'unknown')}</span>
          <span>${fmtDate(task.startedAt)}</span>
          <span>${fmtDuration(task.durationMs)}</span>
          <span>${fmtNumber(task.runCount)} runs</span>
          ${metricBadges(metrics, {
            toolCalls: task.toolCounts?.totalToolCalls,
            subagents: task.subagentCount,
          })}
        </div>
        ${usageBar(metrics.cacheHitRatio)}
      </div>
      ${expanded ? `
        <div class="usage-task-detail">
          ${(task.runs || []).map(renderUsageRunLine).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderUsageGroup(title, rows = []) {
  if (!rows.length) return '';
  return `
    <div class="usage-group-card">
      <h3>${escHtml(title)}</h3>
      <div class="usage-group-table">
        ${rows.map(row => `
          <div class="usage-group-row">
            <span class="usage-group-key">${escHtml(row.key)}</span>
            <span>${fmtNumber(row.requestCount)} req</span>
            <span>${fmtPercent(row.weightedCacheHitRatio)}</span>
            <span>${fmtDuration(row.averageDurationMs)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

export function renderUsageReport() {
  const report = state.usage;
  if (!report) {
    dom.usageSummary.innerHTML = '<div class="empty-panel">No usage data loaded.</div>';
    dom.usageGroups.innerHTML = '';
    dom.usageRunList.innerHTML = '';
    dom.usageGeneratedAt.textContent = '';
    return;
  }

  const s = report.summary || {};
  dom.usageSummary.innerHTML = [
    metricCard('Tasks', fmtNumber((report.tasks || []).length), `${fmtNumber(s.requestCount)} runs`),
    metricCard('Cache Hit', fmtPercent(s.weightedCacheHitRatio), `${fmtNumber(s.cacheReadInputTokens)} cached tokens`),
    metricCard('Input', fmtNumber(s.totalInputTokens), `${fmtNumber(s.uncachedInputTokens)} uncached`),
    metricCard('Output', fmtNumber(s.outputTokens), 'generated tokens'),
    metricCard('Latency', fmtDuration(s.averageDurationMs), 'average duration'),
    metricCard('Web Search', fmtNumber(s.webSearchRequests), 'requests'),
  ].join('');

  dom.usageGroups.innerHTML = [
    renderUsageGroup('By Role', report.groups?.byRole || []),
    renderUsageGroup('By Model', report.groups?.byModel || []),
    renderUsageGroup('By Status', report.groups?.byStatus || []),
  ].join('');

  dom.usageGeneratedAt.textContent = `Generated ${fmtDate(report.generatedAt)}`;
  const tasks = report.tasks || [];
  if (!tasks.length) {
    dom.usageRunList.innerHTML = '<div class="empty-panel">No agent tasks found.</div>';
    return;
  }

  dom.usageRunList.innerHTML = tasks.map(renderUsageTask).join('');
}

export function showUsageRunDetail(run) {
  if (!run) return;
  dom.usageDetailTitle.textContent = run.label || run.task || run.runId;
  const parts = [];
  parts.push(`
    <div class="detail-section">
      <div class="detail-meta-grid">
        <div class="detail-meta-item"><div class="dm-label">Role</div><div class="dm-value">${escHtml(run.role)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Status</div><div class="dm-value">${escHtml(run.status)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Cache Hit</div><div class="dm-value">${fmtPercent(run.metrics?.cacheHitRatio)}</div></div>
        <div class="detail-meta-item"><div class="dm-label">Duration</div><div class="dm-value">${fmtDuration(run.durationMs)}</div></div>
      </div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Token Metrics</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.metrics || {}, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Tool Counts</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify({ ...(run.toolCounts || {}), subagentCount: run.subagentCount }, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Raw Usage</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify(run.usage || {}, null, 2))}</pre></div>
    </div>
  `);
  parts.push(`
    <div class="detail-section">
      <div class="detail-label">Run</div>
      <div class="detail-value"><pre>${escHtml(JSON.stringify({
        runId: run.runId,
        rootRunId: run.rootRunId,
        parentRunId: run.parentRunId,
        conversationId: run.conversationId,
        model: run.model,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        task: run.task,
      }, null, 2))}</pre></div>
    </div>
  `);
  dom.usageDetailBody.innerHTML = parts.join('');
  dom.usageRunDetail.classList.remove('hidden');
}

export function hideUsageRunDetail() {
  dom.usageRunDetail.classList.add('hidden');
}

export function renderConvoList() {
  dom.convList.innerHTML = state.conversations.map(conversation =>
    `<div class="conv-item${conversation.id === state.activeId ? ' active' : ''}" data-id="${conversation.id}">
      <span class="conv-title">${escHtml(conversation.title)}</span>
      <button class="conv-delete" data-id="${conversation.id}" title="Delete">×</button>
    </div>`
  ).join('');
}

export function hydrateAssistantMessages(messages) {
  const toolResultsByAssistant = {};

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const map = {};

    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role !== 'user') break;
      if (!Array.isArray(next.content)) continue;
      for (const part of next.content) {
        if (part.type !== 'tool_result' || typeof part.content !== 'string') continue;
        try {
          const data = JSON.parse(part.content);
          if (Array.isArray(data.uuids)) {
            map[part.tool_use_id] = { type: 'uuid-list', uuids: data.uuids, count: data.count ?? data.uuids.length };
          }
        } catch {}
      }
    }

    if (Object.keys(map).length) {
      toolResultsByAssistant[i] = map;
    }
  }

  const hydrated = messages.map((message, i) => {
    if (message.role !== 'assistant') return message;
    const toolMap = toolResultsByAssistant[i];
    if (Array.isArray(message.blocks)) {
      if (toolMap && !message.blocks.some(block => block.type === 'uuid-list')) {
        const blocks = contentToBlocks(message.content, message.sources, message.searchCount, toolMap);
        if (blocks) return { ...message, blocks };
      }
      return message;
    }
    const blocks = contentToBlocks(message.content, message.sources, message.searchCount, toolMap);
    return blocks ? { ...message, blocks } : message;
  });

  for (const msg of hydrated) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.blocks)) continue;
    let lastTextIdx = -1;
    let firstPostTextUuid = -1;
    for (let i = 0; i < msg.blocks.length; i++) {
      const block = msg.blocks[i];
      if (block.type === 'text' && block.content?.trim()) lastTextIdx = i;
      if (block.type === 'uuid-list' && lastTextIdx >= 0 && firstPostTextUuid < 0) firstPostTextUuid = i;
    }
    if (firstPostTextUuid < 0) continue;
    const before = msg.blocks.slice(0, lastTextIdx).filter(block => block.type !== 'uuid-list');
    const uuids = msg.blocks.filter(block => block.type === 'uuid-list');
    const after = msg.blocks.slice(lastTextIdx).filter(block => block.type !== 'uuid-list');
    msg.blocks = [...before, ...uuids, ...after];
  }

  return hydrated;
}

export function isVisibleMessage(message) {
  if (message.role === 'tool') return false;
  return messageText(message).trim().length > 0;
}

export function renderMessages() {
  const visibleMessages = state.messages.filter(isVisibleMessage);
  if (visibleMessages.length === 0) {
    dom.messages.innerHTML = `
      <div class="empty-state">
        <div class="brand">xwork</div>
        <p>Ask anything. Configure channels in Settings to get started.</p>
      </div>`;
    return;
  }

  dom.messages.innerHTML = visibleMessages.map(message => {
    if (message.role === 'assistant' && Array.isArray(message.blocks)) {
      return `<div class="message assistant">
        <div class="role-label">ASSISTANT</div>
        <div class="content">${renderBlocks(message.blocks, true)}</div>
      </div>`;
    }
    return `<div class="message ${message.role}">
      <div class="role-label">${message.role === 'user' ? 'YOU' : 'ASSISTANT'}</div>
      <div class="content">${renderContent(messageText(message))}</div>
      ${message.role === 'assistant' ? `<div class="web-sources">${renderSourceCards(messageSources(message), true, message.searchCount || 0)}</div>` : ''}
    </div>`;
  }).join('');
}

export function addUserMessage(text) {
  const emptyState = dom.messages.querySelector('.empty-state');
  if (emptyState) dom.messages.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `<div class="role-label">You</div><div class="content">${renderContent(text)}</div>`;
  dom.messages.appendChild(div);
  scrollBottom();
}

export function addAssistantPlaceholder() {
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
