import { dom } from './dom.js';
import { state } from './state.js';
import { disposeEchartsIn, renderBlocks, renderPendingMermaid, renderPendingEcharts } from './renderers.js';
import { maintainAutoScrollAnchor, scrollBottom } from './views.js';

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

function echartsSourceKey(block) {
  return block.querySelector('.echarts-source code')?.textContent || '';
}

function reusableEchartsBlock(block) {
  if (!block || block.dataset.pending === 'true') return false;
  return block.dataset.rendered === 'true'
    || block.dataset.rendering === 'true'
    || block.dataset.error === 'true';
}

function findReusableEchartsBySource(oldEl) {
  const bySource = new Map();
  for (const block of oldEl.querySelectorAll('.echarts-block')) {
    if (!reusableEchartsBlock(block)) continue;
    const source = echartsSourceKey(block);
    if (!source.trim()) continue;
    const blocks = bySource.get(source) || [];
    blocks.push(block);
    bySource.set(source, blocks);
  }
  return bySource;
}

function matchingReusableEchartsBlock(newBlock, bySource) {
  if (!newBlock || newBlock.dataset.pending === 'true') return null;
  const source = echartsSourceKey(newBlock);
  if (!source.trim()) return null;
  const blocks = bySource.get(source);
  if (!blocks?.length) return null;
  return blocks.shift();
}

function replaceBlockPreservingEcharts(oldEl, newEl) {
  const bySource = findReusableEchartsBySource(oldEl);
  if (!bySource.size) return false;

  let preserved = false;
  const desiredNodes = [...newEl.childNodes].map(node => {
    if (!node.matches?.('.echarts-block')) return node;
    const match = matchingReusableEchartsBlock(node, bySource);
    if (!match) return node;
    preserved = true;
    return match;
  });

  if (!preserved) return false;

  oldEl.dataset.blockHash = newEl.dataset.blockHash;
  const preservedNodes = new Set(desiredNodes.filter(node => node.parentNode === oldEl));
  for (const child of [...oldEl.childNodes]) {
    if (!preservedNodes.has(child)) {
      disposeEchartsIn(child);
      child.remove();
    }
  }

  for (let i = 0; i < desiredNodes.length; i += 1) {
    const node = desiredNodes[i];
    const current = oldEl.childNodes[i] || null;
    if (current !== node) oldEl.insertBefore(node, current);
  }

  return true;
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

  function renderNow({ rememberCollapseState = true, renderMermaid = 'closed', renderEcharts = 'closed' } = {}) {
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
    const html = renderBlocks(blocks, false, { wrapBlocks: true });

    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const newEls = [...tmp.children];
    const validIds = new Set();

    for (let i = 0; i < newEls.length; i++) {
      const newEl = newEls[i];
      const id = newEl.dataset.blockId;
      const hash = newEl.dataset.blockHash;
      validIds.add(id);
      const oldEl = contentEl.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      if (oldEl && oldEl.dataset.blockHash === hash) {
        if (contentEl.children[i] !== oldEl) {
          contentEl.insertBefore(oldEl, contentEl.children[i] || null);
        }
      } else if (oldEl) {
        if (replaceBlockPreservingEcharts(oldEl, newEl)) {
          if (contentEl.children[i] !== oldEl) {
            contentEl.insertBefore(oldEl, contentEl.children[i] || null);
          }
        } else {
          disposeEchartsIn(oldEl);
          oldEl.replaceWith(newEl);
        }
      } else {
        contentEl.insertBefore(newEl, contentEl.children[i] || null);
      }
    }

    [...contentEl.querySelectorAll('[data-block-id]')].forEach(el => {
      if (!validIds.has(el.dataset.blockId)) {
        disposeEchartsIn(el);
        el.remove();
      }
    });

    renderPendingMermaid(contentEl, {
      defer: renderMermaid === false,
      closedOnly: renderMermaid === 'closed',
    });
    renderPendingEcharts(contentEl, {
      defer: renderEcharts === false,
      closedOnly: renderEcharts === 'closed',
    });
    maintainAutoScrollAnchor(contentEl);
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
