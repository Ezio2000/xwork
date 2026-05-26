import { dom } from './dom.js';
import { state } from './state.js';
import { renderBlocks, renderPendingMermaid } from './renderers.js';
import { scrollBottom } from './views.js';

const STREAM_RENDER_INTERVAL_MS = 80;

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

function rememberAllCollapseStates(blocks, contentEl) {
  for (const block of blocks) {
    if (block.type === 'subagent-run') rememberSubagentCollapseState(block, contentEl);
  }
  rememberSourceCollapseStates(blocks, contentEl);
}

function scrollRunningSubagentsToBottom(contentEl) {
  contentEl.querySelectorAll('.subagent-toggle.running .subagent-content').forEach(el => {
    el.scrollTop = el.scrollHeight;
  });
}

export function getStreamingContentEl(stream) {
  if (!stream || state.activeId !== stream.conversationId) return null;
  return dom.messages.querySelector(`.message.assistant.streaming[data-chat-run-id="${stream.runId}"] .content`);
}

export function createStreamRenderScheduler(stream) {
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

  function renderNow({ rememberCollapseState = true, renderMermaid = false } = {}) {
    timerId = 0;
    frameId = 0;
    lastRenderedAt = Date.now();
    const contentEl = getStreamingContentEl(stream);
    if (!contentEl) return;
    if (rememberCollapseState) rememberAllCollapseStates(stream.blocks, contentEl);
    const blocks = stream.blocks.map(block => (
      block.type === 'ask-user' && block.status === 'waiting' && stream.runId
        ? { ...block, runId: stream.runId }
        : block
    ));
    contentEl.innerHTML = renderBlocks(blocks, false);
    renderPendingMermaid(contentEl, { defer: !renderMermaid });
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
