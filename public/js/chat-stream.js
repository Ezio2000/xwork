import { dom } from './dom.js';
import { state } from './state.js';
import { escHtml, mergeSources, renderBlocks } from './renderers.js';
import { hideThinkingPopup, showThinkingPopup } from './thinking-popup.js';
import { addAssistantPlaceholder, addUserMessage, renderConvoList, scrollBottom } from './views.js';
import { api } from './api-client.js';

function currentTextBlock(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text') return blocks[i];
  }
  const block = { type: 'text', content: '' };
  blocks.push(block);
  return block;
}

async function ensureConversation(message) {
  if (state.activeId) return;

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
}

function appendStreamEvent(evt, { blocks, contentEl }) {
  if (evt.type === 'thinking') {
    showThinkingPopup(evt.text);
    return;
  }

  if (evt.type === 'delta') {
    hideThinkingPopup();
    currentTextBlock(blocks).content += evt.text;
    contentEl.innerHTML = renderBlocks(blocks, false);
    scrollBottom();
    return;
  }

  if (evt.type === 'tool_call') {
    contentEl.innerHTML = renderBlocks(blocks, false);
    scrollBottom();
    return;
  }

  if (evt.type === 'tool_result') {
    for (const tool of evt.tools) {
      if (tool.renderType && tool.data) {
        blocks.push({ type: tool.renderType, ...tool.data });
      }
    }
    const errored = evt.tools.filter(tool => tool.isError).map(tool => tool.name).join(', ');
    if (errored) currentTextBlock(blocks).content += `\n\n_Tool error: ${errored}_`;
    blocks.push({ type: 'text', content: '' });
    contentEl.innerHTML = renderBlocks(blocks, false);
    scrollBottom();
    return;
  }

  if (evt.type === 'error') {
    contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(evt.message)}</span>`;
  }
}

async function readChatStream(res, view) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const blocks = [{ type: 'text', content: '' }];

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
        appendStreamEvent(JSON.parse(jsonStr), { blocks, contentEl: view.contentEl });
      } catch {}
    }
  }

  return blocks;
}

function finalizeStreamingMessage(blocks, message) {
  hideThinkingPopup();
  const streamingEl = dom.messages.querySelector('.streaming');
  if (streamingEl) {
    streamingEl.classList.remove('streaming');
    streamingEl.querySelectorAll('.sources-toggle').forEach(toggle => toggle.classList.add('collapsed'));
  }

  const allSources = blocks
    .filter(block => block.type === 'source-cards' || block.type === 'sources')
    .flatMap(block => block.sources || [])
    .reduce((acc, source) => mergeSources(acc, [source]), []);
  const totalSearchCount = blocks.reduce((sum, block) => sum + (block.searchCount || 0), 0);

  state.messages.push({ role: 'user', content: message });
  state.messages.push({
    role: 'assistant',
    blocks,
    model: state.activeModel,
    sources: allSources,
    searchCount: totalSearchCount,
  });

  const conv = state.conversations.find(item => item.id === state.activeId);
  if (conv && (state.messages.length <= 2 || conv.title === 'New Chat')) {
    conv.title = message.slice(0, 50) + (message.length > 50 ? '…' : '');
    dom.chatTitle.textContent = conv.title;
    renderConvoList();
  }
}

export async function sendMessage(text) {
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

  let assistantView;
  try {
    await ensureConversation(message);
    assistantView = addAssistantPlaceholder();

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
      try {
        errMsg = JSON.parse(err).error || errMsg;
      } catch {}
      throw new Error(errMsg);
    }

    const blocks = await readChatStream(res, assistantView);
    finalizeStreamingMessage(blocks, message);
  } catch (err) {
    const contentEl = assistantView?.contentEl || dom.messages.querySelector('.streaming .content');
    if (contentEl) contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(err.message)}</span>`;
    const streamingEl = dom.messages.querySelector('.streaming');
    if (streamingEl) streamingEl.classList.remove('streaming');
  }

  state.streaming = false;
  dom.btnSend.disabled = false;
  dom.msgInput.focus();
}
