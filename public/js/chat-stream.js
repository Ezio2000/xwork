import { dom } from './dom.js';
import { state } from './state.js';
import { escHtml, mergeSources, renderBlocks, subagentEventToBlocks } from './renderers.js';
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

const STREAM_RENDER_INTERVAL_MS = 80;

function createStreamRenderScheduler(blocks, contentEl) {
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
    if (rememberCollapseState) rememberAllCollapseStates(blocks, contentEl);
    contentEl.innerHTML = renderBlocks(blocks, false);
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

function appendStreamEvent(evt, { blocks, contentEl, renderer }) {
  if (evt.type === 'thinking') {
    showThinkingPopup(evt.text);
    return;
  }

  if (evt.type === 'delta') {
    hideThinkingPopup();
    currentTextBlock(blocks).content += evt.text;
    renderer.schedule();
    return;
  }

  if (evt.type === 'tool_call') {
    renderer.schedule();
    return;
  }

  if (evt.type === 'tool_result') {
    for (const tool of evt.tools) {
      if (tool.renderType && tool.data) {
        if (tool.renderType === 'subagent-run' && tool.data.runId) {
          const existing = blocks.find(block => block.type === 'subagent-run' && block.runId === tool.data.runId);
          if (existing) {
            Object.assign(existing, { ...tool.data, type: 'subagent-run' });
            if (existing.collapsed === undefined && isTerminalSubagentBlock(existing)) existing.collapsed = true;
            continue;
          }
        }
        const block = { type: tool.renderType, ...tool.data };
        if (isTerminalSubagentBlock(block)) block.collapsed = true;
        if (block.type === 'source-cards' || block.type === 'sources') block.collapsed = true;
        blocks.push(block);
      }
    }
    const errored = evt.tools.filter(tool => tool.isError).map(tool => tool.name).join(', ');
    if (errored) currentTextBlock(blocks).content += `\n\n_Tool error: ${errored}_`;
    blocks.push({ type: 'text', content: '' });
    renderer.schedule();
    return;
  }

  if (evt.type === 'agent_event') {
    const agentEventType = evt.eventType || evt.event || '';
    if (agentEventType === 'root_start') return;
    if (agentEventType === 'subagent_thinking') {
      const block = blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
      if (block) block.thinking = true;
      renderer.schedule();
      return;
    }
    if (agentEventType === 'subagent_start') {
      let block = blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
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
        blocks.push(block);
      }
      pushSubagentEvent(block, evt);
    } else if (agentEventType === 'subagent_delta') {
      hideThinkingPopup();
      const block = blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
      if (block) {
        appendSubagentText(block, evt.text || '');
      }
    } else if (agentEventType === 'subagent_done') {
      hideThinkingPopup();
      const block = blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
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
      renderer.flush({ rememberCollapseState: false });
      return;
    } else if (agentEventType === 'subagent_tool_call' || agentEventType === 'subagent_server_tool') {
      const block = blocks.find(item => item.type === 'subagent-run' && item.runId === evt.runId);
      if (block) {
        block.thinking = false;
        pushSubagentEvent(block, evt);
      }
    } else if (agentEventType === 'subagent_tool_result') {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.type === 'subagent-run' && block.runId === evt.runId) {
          block.thinking = false;
          block.status = evt.isError ? 'tool_error' : block.status || 'running';
          pushSubagentEvent(block, evt);
          break;
        }
      }
    }
    renderer.schedule();
    return;
  }

  if (evt.type === 'error') {
    renderer.cancel();
    contentEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(evt.message)}</span>`;
  }
}

async function readChatStream(res, view) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const blocks = [{ type: 'text', content: '' }];
  const renderer = createStreamRenderScheduler(blocks, view.contentEl);

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
        appendStreamEvent(JSON.parse(jsonStr), { blocks, contentEl: view.contentEl, renderer });
      } catch {}
    }
  }

  renderer.flush();
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
