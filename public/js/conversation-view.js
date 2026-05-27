import { dom } from './dom.js';
import { contentToBlocks, messageSources, messageText } from './message-blocks.js';
import { escHtml, renderBlocks, renderContent, renderPendingMermaid, renderPendingEcharts, renderSourceCards, renderUserMessage } from './renderers.js';
import { state } from './state.js';

const SCROLL_THRESHOLD = 80;

let autoScrollEnabled = true;

export function resetAutoScroll() {
  autoScrollEnabled = true;
  dom.scrollBottomBtn.hidden = true;
}

export function scrollBottom() {
  if (!autoScrollEnabled) return;
  requestAnimationFrame(() => {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  });
}

function updateScrollButton() {
  const isStreaming = state.streamingByConversationId.size > 0;
  dom.scrollBottomBtn.hidden = autoScrollEnabled || !isStreaming;
}

function installScrollListener() {
  let ticking = false;
  dom.messages.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const el = dom.messages;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < SCROLL_THRESHOLD) {
        if (!autoScrollEnabled) {
          autoScrollEnabled = true;
          updateScrollButton();
        }
      } else {
        if (autoScrollEnabled) {
          autoScrollEnabled = false;
          updateScrollButton();
        }
      }
    });
  }, { passive: true });

  dom.scrollBottomBtn.addEventListener('click', () => {
    autoScrollEnabled = true;
    updateScrollButton();
    dom.messages.scrollTo({ top: dom.messages.scrollHeight, behavior: 'smooth' });
  });
}

installScrollListener();

export function renderConvoList() {
  dom.convList.innerHTML = state.conversations.map(conversation =>
    `<div class="conv-item${conversation.id === state.activeId ? ' active' : ''}" data-id="${conversation.id}">
      <span class="conv-title">${escHtml(conversation.title)}</span>
      <button class="conv-delete" data-id="${conversation.id}" title="Delete">&times;</button>
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
  const stream = state.activeId ? state.streamingByConversationId.get(state.activeId) : null;
  if (visibleMessages.length === 0 && !stream) {
    dom.messages.innerHTML = `
      <div class="empty-state">
        <div class="brand">xwork</div>
        <p>Ask anything. Configure channels in Settings to get started.</p>
      </div>`;
    return;
  }

  const pendingMessages = [...visibleMessages];
  if (stream && pendingMessages.length <= stream.originalMessageCount) {
    pendingMessages.push({ role: 'user', content: stream.message });
  }

  const html = pendingMessages.map(message => {
    const actions = `<div class="message-actions"><button class="action-copy" title="Copy">⎘</button></div>`;
    if (message.role === 'assistant' && Array.isArray(message.blocks)) {
      return `<div class="message assistant">
        <div class="content">${renderBlocks(message.blocks, true)}</div>
        ${actions}
      </div>`;
    }
    const body = message.role === 'user'
      ? renderUserMessage(messageText(message))
      : renderContent(messageText(message));
    return `<div class="message ${message.role}">
      <div class="content">${body}</div>
      ${message.role === 'assistant' ? `<div class="web-sources">${renderSourceCards(messageSources(message), true, message.searchCount || 0)}</div>` : ''}
      ${actions}
    </div>`;
  }).join('');
  dom.messages.innerHTML = stream
    ? `${html}
      <div class="message assistant streaming" data-chat-run-id="${escHtml(stream.runId || '')}">
        <div class="content"></div>
      </div>`
    : html;
  renderPendingMermaid(dom.messages);
  renderPendingEcharts(dom.messages);
}

export function addUserMessage(text) {
  const emptyState = dom.messages.querySelector('.empty-state');
  if (emptyState) dom.messages.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `<div class="content">${renderUserMessage(text)}</div>`;
  dom.messages.appendChild(div);
  renderPendingMermaid(div);
  renderPendingEcharts(div);
  scrollBottom();
}

export function addAssistantPlaceholder(stream = null) {
  const div = document.createElement('div');
  div.className = 'message assistant streaming';
  if (stream?.runId) div.dataset.chatRunId = stream.runId;
  div.innerHTML = `<div class="content"></div>`;
  dom.messages.appendChild(div);
  scrollBottom();
  return {
    rootEl: div,
    contentEl: div.querySelector('.content'),
  };
}
