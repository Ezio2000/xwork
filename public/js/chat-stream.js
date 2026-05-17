import { dom } from './dom.js';
import { state } from './state.js';
import { escHtml, mergeSources, renderBlocks, subagentEventToBlocks } from './renderers.js';
import { hideThinkingPopup, showThinkingPopup } from './thinking-popup.js';
import { addAssistantPlaceholder, addUserMessage, renderConvoList, renderMessages, scrollBottom } from './views.js';
import { api } from './api-client.js';

const STREAM_RENDER_INTERVAL_MS = 80;

function currentTextBlock(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text') return blocks[i];
  }
  const block = { type: 'text', content: '' };
  blocks.push(block);
  return block;
}

function pushSubagentEvent(block, evt) {
  const eventType = evt.eventType || evt.type || evt.event || '';
  if (eventType === 'subagent_delta' || eventType === 'subagent_thinking') return;
  block.events = Array.isArray(block.events) ? block.events : [];
  block.events.push({ ...evt });
  if (block.events.length > 80) block.events = block.events.slice(-80);
  block.timeline = Array.isArray(block.timeline) ? block.timeline : [];
  block.timeline.push({ kind: 'event', event: { ...evt } });
  if (block.timeline.length > 160) block.timeline = block.timeline.slice(-160);
  block.blocks = Array.isArray(block.blocks) ? block.blocks : [];
  block.blocks.push(...subagentEventToBlocks(evt));
}

function appendSubagentText(block, text) {
  if (!text) return;
  block.thinking = false;
  block.text = (block.text || '') + text;
  block.timeline = Array.isArray(block.timeline) ? block.timeline : [];
  const last = block.timeline[block.timeline.length - 1];
  if (last?.kind === 'text') {
    last.text += text;
  } else {
    block.timeline.push({ kind: 'text', text });
  }
  if (block.timeline.length > 160) block.timeline = block.timeline.slice(-160);
  block.blocks = Array.isArray(block.blocks) ? block.blocks : [];
  const lastBlock = block.blocks[block.blocks.length - 1];
  if (lastBlock?.type === 'text') {
    lastBlock.content += text;
  } else {
    block.blocks.push({ type: 'text', content: text });
  }
}

function rememberSubagentCollapseState(block, contentEl) {
  if (!block?.runId || !contentEl) return;
  const escapedRunId = window.CSS?.escape ? CSS.escape(block.runId) : String(block.runId).replace(/"/g, '\\"');
  const selector = `.subagent-toggle[data-agent-run-id="${escapedRunId}"]`;
  const current = contentEl.querySelector(selector);
  if (!current) return;
  block.collapsed = current.classList.contains('collapsed');
}

function rememberSourceCollapseStates(blocks, contentEl) {
  let index = 0;
  const toggles = contentEl.querySelectorAll('.sources-toggle');
  for (const block of blocks) {
    if (block.type !== 'source-cards' && block.type !== 'sources') continue;
    const current = toggles[index];
    if (current) block.collapsed = current.classList.contains('collapsed');
    index++;
  }
}

function rememberAllSubagentCollapseStates(blocks, contentEl) {
  for (const block of blocks) {
    if (block.type === 'subagent-run') rememberSubagentCollapseState(block, contentEl);
  }
}

function rememberAllCollapseStates(blocks, contentEl) {
  rememberAllSubagentCollapseStates(blocks, contentEl);
  rememberSourceCollapseStates(blocks, contentEl);
}

function isTerminalSubagentBlock(block) {
  const status = String(block?.status || '').toLowerCase();
  return block?.type === 'subagent-run' && status && status !== 'running' && status !== 'tool_error';
}

function scrollRunningSubagentsToBottom(contentEl) {
  contentEl.querySelectorAll('.subagent-toggle.running .subagent-content').forEach(el => {
    el.scrollTop = el.scrollHeight;
  });
}

function getStreamingContentEl(stream) {
  if (!stream || state.activeId !== stream.conversationId) return null;
  return dom.messages.querySelector(`.message.assistant.streaming[data-chat-run-id="${stream.runId}"] .content`);
}

function getActiveStream() {
  return state.activeId ? state.streamingByConversationId.get(state.activeId) : null;
}

function setSendDisabled() {
  dom.btnSend.disabled = Boolean(getActiveStream());
}

function createStreamRenderScheduler(stream) {
  let timerId = 0;
  let frameId = 0;
  let lastRenderedAt = 0;
  let cancelled = false;

  function clearScheduled() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = 0;
    }
    if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
  }

  function renderNow({ rememberCollapseState = true } = {}) {
    timerId = 0;
    frameId = 0;
    lastRenderedAt = Date.now();
    const contentEl = getStreamingContentEl(stream);
    if (!contentEl) return;
    if (rememberCollapseState) rememberAllCollapseStates(stream.blocks, contentEl);
    contentEl.innerHTML = renderBlocks(stream.blocks, false);
    scrollRunningSubagentsToBottom(contentEl);
    scrollBottom();
  }

  function requestRenderFrame() {
    frameId = requestAnimationFrame(renderNow);
  }

  return {
    schedule() {
      if (cancelled) return;
      if (timerId || frameId) return;
      const waitMs = Math.max(0, STREAM_RENDER_INTERVAL_MS - (Date.now() - lastRenderedAt));
      if (waitMs > 0) {
        timerId = setTimeout(() => {
          timerId = 0;
          requestRenderFrame();
        }, waitMs);
      } else {
        requestRenderFrame();
      }
    },
    flush(options) {
      if (cancelled) return;
      clearScheduled();
      renderNow(options);
    },
    cancel() {
      cancelled = true;
      clearScheduled();
    },
  };
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

function appendStreamEvent(evt, stream) {
  stream.lastSeq = Math.max(stream.lastSeq || 0, Number(evt.seq || 0));

  if (evt.type === 'chat_run_start') {
    if (evt.chatRunId) stream.runId = evt.chatRunId;
    return;
  }

  if (evt.type === 'thinking') {
    if (state.activeId === stream.conversationId) showThinkingPopup(evt.text);
    return;
  }

  if (evt.type === 'delta') {
    if (state.activeId === stream.conversationId) hideThinkingPopup();
    currentTextBlock(stream.blocks).content += evt.text;
    stream.renderer.schedule();
    return;
  }

  if (evt.type === 'tool_call') {
    stream.renderer.schedule();
    return;
  }

  if (evt.type === 'tool_result') {
    for (const tool of evt.tools) {
      if (tool.renderType && tool.data) {
        if (tool.renderType === 'subagent-run' && tool.data.runId) {
          const existing = stream.blocks.find(block => block.type === 'subagent-run' && block.runId === tool.data.runId);
          if (existing) {
            Object.assign(existing, { ...tool.data, type: 'subagent-run' });
            if (existing.collapsed === undefined && isTerminalSubagentBlock(existing)) existing.collapsed = true;
            continue;
          }
        }
        const block = { type: tool.renderType, ...tool.data };
        if (isTerminalSubagentBlock(block)) block.collapsed = true;
        if (block.type === 'source-cards' || block.type === 'sources') block.collapsed = true;
        stream.blocks.push(block);
      }
    }
    const errored = evt.tools.filter(tool => tool.isError).map(tool => tool.name).join(', ');
    if (errored) currentTextBlock(stream.blocks).content += `\n\n_Tool error: ${errored}_`;
    stream.blocks.push({ type: 'text', content: '' });
    stream.renderer.schedule();
    return;
  }

  if (evt.type === 'agent_event') {
    const agentEventType = evt.eventType || evt.event || '';
    if (agentEventType === 'root_start') return;
    if (agentEventType === 'subagent_thinking') {
      const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
      if (block) block.thinking = true;
      stream.renderer.schedule();
      return;
    }
    if (agentEventType === 'subagent_start') {
      let block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
      if (!block) {
        block = {
          type: 'subagent-run',
          runId: evt.runId,
          parentRunId: evt.parentRunId || null,
          status: 'running',
          label: evt.label || 'Subagent',
          task: evt.task || '',
          text: '',
          events: [],
          timeline: [],
          blocks: [],
        };
        stream.blocks.push(block);
      }
      pushSubagentEvent(block, evt);
    } else if (agentEventType === 'subagent_delta') {
      if (state.activeId === stream.conversationId) hideThinkingPopup();
      const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
      if (block) {
        appendSubagentText(block, evt.text || '');
      }
    } else if (agentEventType === 'subagent_done') {
      if (state.activeId === stream.conversationId) hideThinkingPopup();
      const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
      if (block) {
        block.thinking = false;
        block.status = evt.status || 'completed';
        block.text = evt.result?.text || block.text || '';
        block.error = evt.error || '';
        block.durationMs = evt.durationMs ?? block.durationMs;
        block.parentRunId = evt.parentRunId || block.parentRunId || null;
        block.rootRunId = evt.rootRunId || block.rootRunId || null;
        pushSubagentEvent(block, evt);
        block.collapsed = true;
      }
      stream.renderer.flush({ rememberCollapseState: false });
      return;
    } else if (agentEventType === 'subagent_tool_call' || agentEventType === 'subagent_server_tool') {
      const block = stream.blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
      if (block) {
        block.thinking = false;
        pushSubagentEvent(block, evt);
      }
    } else if (agentEventType === 'subagent_tool_result') {
      for (let i = stream.blocks.length - 1; i >= 0; i--) {
        const block = stream.blocks[i];
        if (block.type === 'subagent-run' && block.runId === evt.runId) {
          block.thinking = false;
          block.status = evt.isError ? 'tool_error' : block.status || 'running';
          pushSubagentEvent(block, evt);
          break;
        }
      }
    }
    stream.renderer.schedule();
    return;
  }

  if (evt.type === 'error') {
    stream.status = 'error';
    stream.error = evt.message || 'Unknown error';
    stream.renderer.cancel();
    const contentEl = getStreamingContentEl(stream);
    if (contentEl) contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(stream.error)}</span>`;
  }
}

async function readChatStream(res, stream) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
        appendStreamEvent(evt, stream);
        if (evt.type === 'done' || evt.type === 'error') {
          stream.terminalEvent = evt;
        }
      } catch {}
    }
  }

  stream.renderer.flush();
  return stream.blocks;
}

function finalizeStreamingMessage(stream) {
  if (state.activeId === stream.conversationId) hideThinkingPopup();
  stream.renderer.flush({ rememberCollapseState: false });
  const streamingEl = dom.messages.querySelector(`.message.assistant.streaming[data-chat-run-id="${stream.runId}"]`);
  if (streamingEl) {
    streamingEl.classList.remove('streaming');
    streamingEl.querySelectorAll('.sources-toggle').forEach(toggle => toggle.classList.add('collapsed'));
  }

  const allSources = stream.blocks
    .filter(block => block.type === 'source-cards' || block.type === 'sources')
    .flatMap(block => block.sources || [])
    .reduce((acc, source) => mergeSources(acc, [source]), []);
  const totalSearchCount = stream.blocks.reduce((sum, block) => sum + (block.searchCount || 0), 0);

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

  state.streamingByConversationId.delete(stream.conversationId);
  setSendDisabled();
}

function markStreamErrored(stream, err) {
  stream.status = 'error';
  stream.error = err.message || String(err);
  const contentEl = getStreamingContentEl(stream);
  if (contentEl) contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(stream.error)}</span>`;
  const streamingEl = dom.messages.querySelector(`.message.assistant.streaming[data-chat-run-id="${stream.runId}"]`);
  if (streamingEl) streamingEl.classList.remove('streaming');
  state.streamingByConversationId.delete(stream.conversationId);
  setSendDisabled();
}

async function attachStream(stream, resPromise) {
  try {
    const res = await resPromise;
    if (!res.ok) {
      const err = await res.text();
      let errMsg = `Error ${res.status}`;
      try {
        errMsg = JSON.parse(err).error || errMsg;
      } catch {}
      throw new Error(errMsg);
    }
    await readChatStream(res, stream);
    if (!stream.terminalEvent && stream.status === 'running') {
      const url = `/api/v1/chat-runs/${encodeURIComponent(stream.runId)}/stream?afterSeq=${encodeURIComponent(stream.lastSeq || 0)}`;
      attachStream(stream, fetch(url));
      return;
    }
    if (stream.terminalEvent?.type === 'error') {
      markStreamErrored(stream, new Error(stream.terminalEvent.message || 'Unknown error'));
    } else {
      finalizeStreamingMessage(stream);
    }
  } catch (err) {
    markStreamErrored(stream, err);
  }
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
  };
  stream.renderer = createStreamRenderScheduler(stream);
  state.streamingByConversationId.set(conversationId, stream);
  return stream;
}

export function renderActiveStreamingMessage() {
  const stream = getActiveStream();
  if (!stream) {
    setSendDisabled();
    return false;
  }

  const hasPlaceholder = Boolean(dom.messages.querySelector(`.message.assistant.streaming[data-chat-run-id="${stream.runId}"]`));
  if (!hasPlaceholder) addAssistantPlaceholder(stream);
  stream.renderer.flush({ rememberCollapseState: false });
  setSendDisabled();
  return true;
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

    attachStream(stream, fetch('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId,
        conversationId,
        message,
        channelId: dom.channelSelect.value,
        model: dom.modelSelect.value,
      }),
    }));
  } catch (err) {
    alert(err.message || String(err));
    setSendDisabled();
  }
}
