import {
  contentToBlocks,
  mergeSources,
  messageSources,
  messageText,
  stripLeadingNewlines,
  stripSearchQueryText,
  subagentEventToBlocks,
} from './message-blocks.js';

export {
  contentToBlocks,
  mergeSources,
  messageSources,
  messageText,
  stripLeadingNewlines,
  stripSearchQueryText,
  subagentEventToBlocks,
};

marked.setOptions({ breaks: true, gfm: true });

export function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
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

function normalizeMarkdownForDisplay(text) {
  let value = String(text || '').replace(/^\n+/, '');
  value = value.replace(/([一-鿿　-〿＀-￯])(\*{1,2})/g, '$1​$2');
  value = value.replace(/(\*{1,2})([一-鿿　-〿＀-￯])/g, '$1​$2');
  const match = value.match(/^\s*```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1].replace(/^\n+/, '') : value;
}

export function renderContent(text) {
  const { value, displayMath, inlineMath } = renderMath(text);
  let html = marked.parse(normalizeMarkdownForDisplay(value));
  html = html.replace(/\x00DM(\d+)\x00/g, (_, i) => displayMath[+i]);
  html = html.replace(/\x00IM(\d+)\x00/g, (_, i) => inlineMath[+i]);
  return html;
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

export function renderSourceCards(sources, collapsed = false, searchCount = 0) {
  if (!sources?.length) return '';
  const label = searchCount > 0
    ? `${searchCount} search${searchCount > 1 ? 'es' : ''} · ${sources.length} result${sources.length !== 1 ? 's' : ''}`
    : `${sources.length} result${sources.length !== 1 ? 's' : ''}`;
  return `
    <div class="sources-toggle${collapsed ? ' collapsed' : ''}">
      <div class="sources-toggle-header" data-toggle-parent>
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

function renderUuidList(uuids, count) {
  if (!uuids?.length) return '';
  const label = count === 1 ? 'UUID' : `${count} UUIDs`;
  return `
    <div class="uuid-toggle collapsed">
      <div class="uuid-toggle-header" data-toggle-parent>
        <span class="uuid-toggle-label">${label}</span>
        <span class="uuid-toggle-arrow">▾</span>
      </div>
      <div class="uuid-toggle-body">
        <div class="uuid-list-container">
          <div class="uuid-list-header">
            <button class="uuid-copy-all" data-copy-uuids="${escHtml(JSON.stringify(uuids))}">Copy all</button>
          </div>
          <div class="uuid-list">
            ${uuids.map((uuid, i) => `
              <div class="uuid-row">
                <span class="uuid-index">${i + 1}</span>
                <code class="uuid-value">${escHtml(uuid)}</code>
                <button class="uuid-copy-one" data-copy-uuid="${escHtml(uuid)}" title="Copy">Copy</button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function isTerminalSubagentStatus(status) {
  const value = String(status || '').toLowerCase();
  return value && value !== 'running' && value !== 'tool_error';
}

function renderSubagentRun(block, collapsed) {
  const status = block.status || 'running';
  const label = block.label || block.task || 'Subagent';
  const blocks = subagentFrameBlocks(block);
  const runCollapsed = typeof block.collapsed === 'boolean'
    ? block.collapsed
    : Boolean(collapsed && isTerminalSubagentStatus(status));
  const nestedCollapsed = collapsed || runCollapsed;
  const runningClass = status === 'running' ? ' running' : '';
  const statusLabel = block.thinking && status === 'running' ? 'thinking...' : status;
  return `
    <div class="subagent-toggle${runningClass}${runCollapsed ? ' collapsed' : ''}" data-agent-run-id="${escHtml(block.runId || '')}">
      <div class="subagent-toggle-header" data-toggle-parent>
        <span class="subagent-toggle-label">${escHtml(label)}</span>
        <span class="subagent-status ${escHtml(status)}">${escHtml(statusLabel)}</span>
        <span class="subagent-toggle-arrow">▾</span>
      </div>
      <div class="subagent-toggle-body">
        <div class="subagent-content">${renderBlocks(blocks, nestedCollapsed)}</div>
      </div>
    </div>
  `;
}

function subagentFrameBlocks(block) {
  const out = [];
  const meta = [
    block.durationMs !== undefined && block.durationMs !== null ? `${Number(block.durationMs || 0)}ms` : '',
    block.runId ? `run ${String(block.runId).slice(0, 8)}` : '',
  ].filter(Boolean).join(' · ');

  if (meta) out.push({ type: 'text', content: `_${meta}_` });
  if (block.task) out.push({ type: 'text', content: blockquote(block.task) });
  const content = Array.isArray(block.blocks) && block.blocks.length
    ? block.blocks
    : subagentContentBlocks(block);
  out.push(...content);

  return out.length ? out : [{ type: 'text', content: 'Running...' }];
}

function subagentContentBlocks(block) {
  const out = [];
  if (Array.isArray(block.timeline) && block.timeline.length) {
    for (const item of block.timeline) {
      if (item?.kind === 'text' && item.text) {
        out.push({ type: 'text', content: item.text });
      } else if (item?.kind === 'event') {
        out.push(...subagentEventToBlocks(item.event));
      }
    }
  } else {
    if (block.text || block.error) out.push({ type: 'text', content: block.text || block.error || '' });
    for (const event of Array.isArray(block.events) ? block.events : []) {
      out.push(...subagentEventToBlocks(event));
    }
  }

  return out;
}

function blockquote(text) {
  return String(text || '')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderWebFetch(block, collapsed = false) {
  const url = block.url || '';
  const statusCode = block.statusCode || 0;
  const contentType = block.contentType || '';
  const contentLength = block.contentLength || 0;
  const cached = block.cached || false;
  const contentPreview = block.contentPreview || '';

  let statusClass = statusCode >= 200 && statusCode < 300 ? 'status-ok'
    : statusCode >= 300 && statusCode < 400 ? 'status-redirect' : 'status-error';

  let displayUrl = url;
  try {
    const parsed = new URL(url);
    displayUrl = parsed.hostname + parsed.pathname;
    if (displayUrl.length > 80) displayUrl = displayUrl.slice(0, 77) + '...';
  } catch {}

  const meta = [`${statusCode}`, contentType, formatBytes(contentLength), cached ? 'cached' : ''].filter(Boolean).join(' · ');
  const previewHtml = contentPreview ? `<div class="web-fetch-preview">${renderContent(contentPreview)}</div>` : '';

  return `
    <div class="web-fetch-toggle${collapsed ? ' collapsed' : ''}">
      <div class="web-fetch-toggle-header" data-toggle-parent>
        <span class="web-fetch-toggle-label">
          <span class="web-fetch-icon">&#8599;</span>
          ${escHtml(displayUrl)}
        </span>
        <span class="web-fetch-meta ${escHtml(statusClass)}">${escHtml(meta)}</span>
        <span class="web-fetch-toggle-arrow">&#9662;</span>
      </div>
      <div class="web-fetch-toggle-body">
        <div class="web-fetch-url">
          <a href="${escHtml(url)}" target="_blank" rel="noreferrer">${escHtml(url)}</a>
        </div>
        ${previewHtml}
      </div>
    </div>
  `;
}

const blockRenderers = {
  'text': (block) => renderContent(stripLeadingNewlines(stripSearchQueryText(block.content || ''))),
  'source-cards': (block, collapsed) => renderSourceCards(block.sources || [], block.collapsed ?? collapsed, block.searchCount || 0),
  'sources': (block, collapsed) => renderSourceCards(block.sources || [], block.collapsed ?? collapsed, block.searchCount || 0),
  'uuid-list': (block) => renderUuidList(block.uuids || [], block.count || 0),
  'subagent-run': (block, collapsed) => renderSubagentRun(block, collapsed),
  'web-fetch': (block, collapsed) => renderWebFetch(block, block.collapsed ?? collapsed),
};

export function renderBlocks(blocks, collapsed) {
  if (!blocks?.length) return '';
  return blocks.map(block => {
    const renderer = blockRenderers[block.type];
    return renderer ? renderer(block, collapsed) : '';
  }).join('');
}

export function installRendererEventHandlers(root = document) {
  root.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle-parent]');
    if (toggle) {
      toggle.parentElement.classList.toggle('collapsed');
      return;
    }

    const copyOne = event.target.closest('[data-copy-uuid]');
    if (copyOne) {
      event.preventDefault();
      navigator.clipboard.writeText(copyOne.dataset.copyUuid).then(() => {
        copyOne.textContent = 'Copied!';
        setTimeout(() => { copyOne.textContent = 'Copy'; }, 1200);
      }).catch(() => {});
      return;
    }

    const copyAll = event.target.closest('[data-copy-uuids]');
    if (copyAll) {
      event.preventDefault();
      try {
        const uuids = JSON.parse(copyAll.dataset.copyUuids);
        navigator.clipboard.writeText(uuids.join('\n')).then(() => {
          copyAll.textContent = 'Copied!';
          setTimeout(() => { copyAll.textContent = 'Copy all'; }, 1200);
        }).catch(() => {});
      } catch {}
    }
  });
}
