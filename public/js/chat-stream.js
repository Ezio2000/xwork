import { api } from './api-client.js';
import { dom } from './dom.js';
import { mergeSources } from './message-blocks.js';
import { escHtml } from './renderers.js';
import { attachChatStream } from './stream-client.js';
import { createStreamRenderScheduler, getStreamingContentEl } from './stream-render-controller.js';
import { hideThinkingPopup } from './thinking-popup.js';
import { collapseFinishedToolBlocks, collapseToolToggleElements } from './tool-block-collapse.js';
import { state } from './state.js';
import { getActiveStream } from './stores/app-store.js';
import { addAssistantPlaceholder, addUserMessage, renderConvoList, renderMessages } from './views.js';

const SEND_ICON = `
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 14V2M8 2L3 7M8 2L13 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

const STOP_ICON = `
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>
  </svg>
`;

function setSendButtonState() {
  const stream = getActiveStream();
  const isStopping = Boolean(stream?.stopping);
  dom.btnSend.disabled = isStopping;
  dom.btnSend.classList.toggle('is-stop', Boolean(stream));
  dom.btnSend.title = stream ? 'Stop' : 'Send';
  dom.btnSend.setAttribute('aria-label', stream ? 'Stop current response' : 'Send message');
  dom.btnSend.innerHTML = stream ? STOP_ICON : SEND_ICON;
}

async function ensureConversation(message) {
  if (state.activeId) return state.activeId;

  const convo = await api('POST', '/api/v1/conversations', {
    title: message.slice(0, 50) + (message.length > 50 ? '…' : ''),
  });

  state.activeId = convo.id;
  state.conversations.unshift({
    id: convo.id,
    title: convo.title,
    createdAt: convo.createdAt,
    updatedAt: convo.updatedAt,
    messageCount: 0,
  });
  dom.chatTitle.textContent = convo.title;
  renderConvoList();
  return convo.id;
}

function finalizeStreamingMessage(stream) {
  if (stream.finalized) return;
  stream.finalized = true;
  if (state.activeId === stream.conversationId) hideThinkingPopup();
  stream.renderer.flush({ rememberCollapseState: false });
  const streamingEl = dom.messages.querySelector(`.message.assistant.streaming[data-chat-run-id="${stream.runId}"]`);
  if (streamingEl) {
    streamingEl.classList.remove('streaming');
    collapseToolToggleElements(streamingEl);
  }

  collapseFinishedToolBlocks(stream.blocks);

  const allSources = stream.blocks
    .filter(block => block.type === 'source-cards' || block.type === 'sources')
    .flatMap(block => block.sources || [])
    .reduce((acc, source) => mergeSources(acc, [source]), []);
  const totalSearchCount = stream.blocks.reduce((sum, block) => sum + (block.searchCount || 0), 0);

  state.streamingByConversationId.delete(stream.conversationId);
  if (state.activeId === stream.conversationId) {
    if (state.messages.length <= stream.originalMessageCount) {
      state.messages.push({ role: 'user', content: stream.message });
    }
    state.messages.push({
      role: 'assistant',
      blocks: stream.blocks,
      model: stream.model,
      sources: allSources,
      searchCount: totalSearchCount,
    });
    renderMessages();
  }

  const conv = state.conversations.find(item => item.id === stream.conversationId);
  if (conv && (stream.originalMessageCount <= 0 || conv.title === 'New Chat')) {
    conv.title = stream.message.slice(0, 50) + (stream.message.length > 50 ? '…' : '');
    if (state.activeId === stream.conversationId) dom.chatTitle.textContent = conv.title;
    renderConvoList();
  }

  setSendButtonState();
}

function markStreamErrored(stream, err) {
  if (stream.finalized) return;
  stream.finalized = true;
  stream.status = 'error';
  stream.error = err.message || String(err);
  const contentEl = getStreamingContentEl(stream);
  if (contentEl) contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(stream.error)}</span>`;
  const streamingEl = dom.messages.querySelector(`.message.assistant.streaming[data-chat-run-id="${stream.runId}"]`);
  if (streamingEl) streamingEl.classList.remove('streaming');
  state.streamingByConversationId.delete(stream.conversationId);
  setSendButtonState();
}

function createStream({ conversationId, runId, message, originalMessageCount, model }) {
  const stream = {
    conversationId,
    runId,
    message,
    originalMessageCount,
    model,
    status: 'running',
    blocks: [{ type: 'text', content: '' }],
    lastSeq: 0,
    terminalEvent: null,
    renderer: null,
    stopping: false,
    finalized: false,
  };
  stream.renderer = createStreamRenderScheduler(stream);
  state.streamingByConversationId.set(conversationId, stream);
  return stream;
}

export function renderActiveStreamingMessage() {
  const stream = getActiveStream();
  if (!stream) {
    setSendButtonState();
    return false;
  }

  const hasPlaceholder = Boolean(dom.messages.querySelector(`.message.assistant.streaming[data-chat-run-id="${stream.runId}"]`));
  if (!hasPlaceholder) addAssistantPlaceholder(stream);
  stream.renderer.flush({ rememberCollapseState: false });
  setSendButtonState();
  return true;
}

export async function stopActiveStream() {
  const stream = getActiveStream();
  if (!stream || stream.stopping) return;

  stream.stopping = true;
  setSendButtonState();
  try {
    await api('POST', `/api/v1/chat-runs/${encodeURIComponent(stream.runId)}/stop`, {
      reason: 'user_stopped',
    });
  } catch (err) {
    if (err.status === 404) {
      stream.status = 'completed';
      stream.terminalEvent = { type: 'done', stopReason: 'user_stopped' };
      finalizeStreamingMessage(stream);
      return;
    }
    stream.stopping = false;
    setSendButtonState();
    alert(err.message || String(err));
  }
}

export async function sendMessage(text) {
  if (!text.trim()) return;
  if (!state.activeChannelId) {
    alert('Please configure a channel in Settings first.');
    return;
  }
  if (getActiveStream()) return;

  const message = text.trim();
  dom.msgInput.value = '';
  dom.msgInput.style.height = 'auto';
  dom.btnSend.disabled = true;

  try {
    const conversationId = await ensureConversation(message);
    const originalMessageCount = state.messages.length;
    state.messages.push({ role: 'user', content: message });
    addUserMessage(message);

    const runId = crypto.randomUUID();
    const stream = createStream({
      conversationId,
      runId,
      message,
      originalMessageCount,
      model: dom.modelSelect.value,
    });
    addAssistantPlaceholder(stream);
    setSendButtonState();

    attachChatStream(stream, fetch('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId,
        conversationId,
        message,
        channelId: dom.channelSelect.value,
        model: dom.modelSelect.value,
      }),
    }), {
      onComplete: finalizeStreamingMessage,
      onError: markStreamErrored,
    });
  } catch (err) {
    alert(err.message || String(err));
    setSendButtonState();
  }
}
