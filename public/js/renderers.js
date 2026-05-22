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

const FILE_MENTION_DISPLAY_RE = /(?:^|[\s([{])@([A-Za-z0-9_./\-]+)/g;

export function renderUserMessage(text) {
  const mentionPaths = [];
  const placeholderText = String(text || '').replace(FILE_MENTION_DISPLAY_RE, (match, path) => {
    const id = mentionPaths.length;
    mentionPaths.push(path);
    const prefix = match.slice(0, match.length - path.length - 1);
    return `${prefix}⟦FM${id}⟧`;
  });

  let html = renderContent(placeholderText);
  for (let i = 0; i < mentionPaths.length; i += 1) {
    const token = `⟦FM${i}⟧`;
    const chip = `<span class="file-mention-chip">@${escHtml(mentionPaths[i])}</span>`;
    html = html.split(token).join(chip);
    html = html.split(escHtml(token)).join(chip);
  }
  return html;
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

function renderBrowserAction(block, collapsed = false) {
  const action = block.action || 'browser';
  const title = block.title || block.url || 'Browser action';
  const running = block.status === 'running';
  const error = block.status === 'error';
  const meta = [
    running ? 'running' : error ? 'error' : '',
    action,
    block.statusCode ? `HTTP ${block.statusCode}` : '',
    block.resultType ? String(block.resultType) : '',
    block.truncated ? 'truncated' : '',
    block.closed ? 'closed' : '',
  ].filter(Boolean).join(' · ');
  const bodyParts = [];

  if (block.url) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>URL</span>
        <a href="${escHtml(block.url)}" target="_blank" rel="noreferrer">${escHtml(block.url)}</a>
      </div>
    `);
  }
  if (block.selector) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Selector</span>
        <code>${escHtml(block.selector)}</code>
      </div>
    `);
  }
  if (block.textQuery) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Text</span>
        <code>${escHtml(block.textQuery)}</code>
      </div>
    `);
  }
  if (block.key) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Key</span>
        <code>${escHtml(block.key)}</code>
      </div>
    `);
  }
  if (block.screenshotPath) {
    bodyParts.push(`
      <div class="browser-action-row">
        <span>Screenshot</span>
        <code>${escHtml(block.screenshotPath)}</code>
      </div>
    `);
  }
  if (block.screenshotUrl) {
    bodyParts.push(`
      <div class="browser-action-preview">
        <a href="${escHtml(block.screenshotUrl)}" target="_blank" rel="noreferrer">
          <img src="${escHtml(block.screenshotUrl)}" alt="Browser screenshot">
        </a>
      </div>
    `);
  }
  if (Array.isArray(block.steps) && block.steps.length) {
    bodyParts.push(`
      <div class="browser-action-steps">
        ${block.steps.map(step => `
          <div class="browser-action-step ${escHtml(step.phase || 'event')}">
            <span class="browser-action-step-dot"></span>
            <span class="browser-action-step-main">
              <span class="browser-action-step-label">${escHtml(browserStepLabel(step))}</span>
              <span class="browser-action-step-meta">${escHtml(browserStepMeta(step))}</span>
            </span>
          </div>
        `).join('')}
      </div>
    `);
  }
  if (Array.isArray(block.matches) && block.matches.length) {
    bodyParts.push(`
      <div class="browser-action-matches">
        ${block.matches.map(match => `
          <div class="browser-action-match">
            <span>#${Number(match.index || 0) + 1}</span>
            <code>${escHtml(match.tagName || '')}</code>
            <span>${escHtml(match.text || '')}</span>
          </div>
        `).join('')}
      </div>
    `);
  }
  if (block.text) {
    bodyParts.push(`<pre class="browser-action-output"><code>${escHtml(block.text)}</code></pre>`);
  }
  if (block.result) {
    bodyParts.push(`<pre class="browser-action-output"><code>${escHtml(block.result)}</code></pre>`);
  }

  return `
    <div class="browser-action-toggle${collapsed ? ' collapsed' : ''}">
      <div class="browser-action-toggle-header" data-toggle-parent>
        <span class="browser-action-toggle-label">
          <span class="browser-action-icon">&#9711;</span>
          ${escHtml(title)}
        </span>
        <span class="browser-action-meta">${escHtml(meta)}</span>
        <span class="browser-action-toggle-arrow">&#9662;</span>
      </div>
      <div class="browser-action-toggle-body">
        ${bodyParts.join('') || '<div class="browser-action-empty">No browser output.</div>'}
      </div>
    </div>
  `;
}

function browserStepLabel(step) {
  if (step.label) return step.label;
  const phase = step.phase || 'event';
  const action = step.action || 'browser';
  return `${phase} ${action}`;
}

function browserStepMeta(step) {
  const parts = [
    step.title,
    step.url,
    step.selector ? `selector ${step.selector}` : '',
    step.textQuery ? `text ${step.textQuery}` : '',
    step.key ? `key ${step.key}` : '',
    step.waitUntil ? `wait ${step.waitUntil}` : '',
    step.waitState ? `state ${step.waitState}` : '',
    step.statusCode ? `HTTP ${step.statusCode}` : '',
    step.count !== undefined ? `${Number(step.count || 0)} matches` : '',
    step.textLength !== undefined ? `${Number(step.textLength || 0)} chars` : '',
    step.resultType ? String(step.resultType) : '',
    step.screenshotPath,
  ].filter(Boolean);
  return parts.join(' · ');
}

function renderGrepMatches(block, collapsed = false) {
  const pattern = block.pattern || '';
  const meta = [
    `${Number(block.matchCount || block.matches?.length || 0)} matches`,
    block.truncated ? 'truncated' : '',
    block.scannedFiles !== undefined ? `${Number(block.scannedFiles)} files scanned` : '',
  ].filter(Boolean).join(' · ');
  const lines = (block.matches || []).map(match => {
    const location = `${match.path}:${match.line}`;
    const context = [
      ...(match.before || []).map(line => `  ${line}`),
      `> ${match.content || ''}`,
      ...(match.after || []).map(line => `  ${line}`),
    ].join('\n');
    return `${location}\n${context}`;
  }).join('\n\n');

  return `
    <div class="shell-command-toggle grep-matches-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">🔎</span>
          grep ${escHtml(pattern)}
        </span>
        <span class="shell-command-meta">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${escHtml(lines || '(no matches)')}</code></pre>
      </div>
    </div>
  `;
}

function renderGlobList(block, collapsed = false) {
  const pattern = block.pattern || '';
  const files = block.files || [];
  const meta = [
    `${files.length} files`,
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const listing = files.map(file => file.path || file.name || '').filter(Boolean).join('\n');

  return `
    <div class="shell-command-toggle glob-list-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">📁</span>
          glob ${escHtml(pattern)}
        </span>
        <span class="shell-command-meta">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${escHtml(listing || '(no files)')}</code></pre>
      </div>
    </div>
  `;
}

function renderFileWrite(block, collapsed = false) {
  const path = block.path || 'file';
  const mode = block.mode || 'overwrite';
  const created = block.created === true;
  const deltaLines = (Number(block.afterLines) || 0) - (Number(block.beforeLines) || 0);
  const deltaBytes = (Number(block.afterSize) || 0) - (Number(block.beforeSize) || 0);
  const fmtDelta = (n) => (n > 0 ? `+${n}` : `${n}`);
  const modeLabel = mode === 'str_replace' ? 'edit' : mode;
  const metaItems = [
    created ? 'created' : modeLabel,
    `lines ${block.afterLines ?? '?'} (${fmtDelta(deltaLines)})`,
    `${block.afterSize ?? '?'} bytes (${fmtDelta(deltaBytes)})`,
    block.replacements ? `${block.replacements} match` : '',
    block.encoding || 'utf-8',
  ].filter(Boolean);
  const meta = metaItems.join(' · ');
  const icon = created ? '🆕' : mode === 'str_replace' ? '✏️' : mode === 'append' ? '➕' : '💾';
  const preview = block.preview || '';

  return `
    <div class="shell-command-toggle file-write-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">${icon}</span>
          ${escHtml(path)}
        </span>
        <span class="shell-command-meta">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${escHtml(preview)}</code></pre>
      </div>
    </div>
  `;
}

const TODO_STATUS_META = {
  pending: { icon: '○', label: 'todo' },
  in_progress: { icon: '◐', label: 'in progress' },
  completed: { icon: '●', label: 'done' },
  cancelled: { icon: '×', label: 'cancelled' },
};

function renderTodoList(block) {
  const todos = Array.isArray(block.todos) ? block.todos : [];
  if (!todos.length) return '';
  const counts = block.counts || {};
  const done = counts.completed || 0;
  const total = block.total || todos.length;
  const items = todos.map(todo => {
    const meta = TODO_STATUS_META[todo.status] || TODO_STATUS_META.pending;
    return `
      <li class="todo-item todo-status-${escHtml(todo.status)}">
        <span class="todo-bullet">${meta.icon}</span>
        <span class="todo-content">${escHtml(todo.content || '')}</span>
        <span class="todo-status-label">${escHtml(meta.label)}</span>
      </li>
    `;
  }).join('');

  return `
    <div class="todo-block">
      <div class="todo-header">
        <span class="todo-title">Todos</span>
        <span class="todo-progress">${done} / ${total}</span>
      </div>
      <ul class="todo-list">${items}</ul>
    </div>
  `;
}

const SYMBOL_KIND_ICON = {
  function: 'ƒ',
  class: '◇',
  interface: 'I',
  type: 'T',
  enum: 'E',
  struct: 'S',
  trait: 'R',
  impl: 'i',
  method: 'm',
  variable: 'v',
};

function renderSymbolList(block, collapsed = false) {
  const symbols = Array.isArray(block.symbols) ? block.symbols : [];
  const path = block.path || 'file';
  const meta = [
    block.language ? `lang: ${block.language}` : '',
    block.symbolCount !== undefined ? `${block.symbolCount} symbol${block.symbolCount === 1 ? '' : 's'}` : '',
    block.totalLines !== undefined ? `${block.totalLines} lines` : '',
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');

  const items = symbols.map(sym => {
    const icon = SYMBOL_KIND_ICON[String(sym.kind).split(' ')[0]] || '·';
    const params = sym.params ? `(${escHtml(sym.params)})` : '';
    return `
      <li class="symbol-item">
        <span class="symbol-icon">${icon}</span>
        <span class="symbol-kind">${escHtml(sym.kind || '')}</span>
        <span class="symbol-name">${escHtml(sym.name || '')}${params}</span>
        <span class="symbol-line">L${Number(sym.line) || '?'}</span>
      </li>
    `;
  }).join('');

  return `
    <div class="shell-command-toggle symbol-list-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">⌘</span>
          ${escHtml(path)}
        </span>
        <span class="shell-command-meta">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <ul class="symbol-list">${items || '<li class="symbol-empty">(no symbols found)</li>'}</ul>
      </div>
    </div>
  `;
}

function renderFileSnippet(block, collapsed = false) {
  const path = block.path || 'file';
  const range = block.startLine && block.endLine
    ? `L${block.startLine}-${block.endLine}`
    : '';
  const meta = [
    range,
    block.encoding || 'utf-8',
    block.truncated ? 'truncated' : '',
    block.size !== undefined ? `${Number(block.size)} bytes` : '',
  ].filter(Boolean).join(' · ');
  const content = block.content || block.contentPreview || '';

  return `
    <div class="shell-command-toggle file-snippet-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">📄</span>
          ${escHtml(path)}
        </span>
        <span class="shell-command-meta">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${escHtml(content)}</code></pre>
      </div>
    </div>
  `;
}

function renderShellCommand(block, collapsed = false) {
  const exitCode = block.exitCode;
  const timedOut = block.timedOut === true;
  const running = block.status === 'running';
  const statusClass = running ? 'status-running' : timedOut || exitCode !== 0 ? 'status-error' : 'status-ok';
  const status = running ? 'running' : timedOut ? 'timeout' : `exit ${exitCode ?? '?'}`;
  const meta = [
    status,
    block.durationMs !== undefined && block.durationMs !== null ? `${Number(block.durationMs || 0)}ms` : '',
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const cwd = block.cwd || '.';
  const command = block.command || 'shell command';
  const stdout = block.stdout || '';
  const stderr = block.stderr || '';
  const prompt = processLikePrompt(cwd);

  return `
    <div class="shell-command-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">&gt;_</span>
          ${escHtml(block.command || 'shell command')}
        </span>
        <span class="shell-command-meta ${escHtml(statusClass)}">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <div class="shell-terminal">
          <div class="shell-terminal-title">
            <span class="shell-terminal-title-text">${escHtml(cwd)}</span>
          </div>
          <div class="shell-terminal-screen">
            <div class="shell-terminal-line shell-terminal-command">
              <span class="shell-terminal-prompt">${escHtml(prompt)}</span>
              <span class="shell-terminal-command-text">${escHtml(command)}</span>
              ${running ? '<span class="shell-terminal-cursor">|</span>' : ''}
            </div>
            ${stdout ? `<pre class="shell-terminal-output stdout"><code>${escHtml(stdout)}</code></pre>` : ''}
            ${stderr ? `<pre class="shell-terminal-output stderr"><code>${escHtml(stderr)}</code></pre>` : ''}
            ${running ? '<div class="shell-terminal-running">running...</div>' : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function processLikePrompt(cwd) {
  const value = String(cwd || '.');
  const short = value.length > 60 ? `...${value.slice(-57)}` : value;
  return `${short}>`;
}

const blockRenderers = {
  'text': (block) => renderContent(stripLeadingNewlines(stripSearchQueryText(block.content || ''))),
  'source-cards': (block, collapsed) => renderSourceCards(block.sources || [], block.collapsed ?? collapsed, block.searchCount || 0),
  'sources': (block, collapsed) => renderSourceCards(block.sources || [], block.collapsed ?? collapsed, block.searchCount || 0),
  'uuid-list': (block) => renderUuidList(block.uuids || [], block.count || 0),
  'subagent-run': (block, collapsed) => renderSubagentRun(block, collapsed),
  'web-fetch': (block, collapsed) => renderWebFetch(block, block.collapsed ?? collapsed),
  'browser-action': (block, collapsed) => renderBrowserAction(block, block.collapsed ?? collapsed),
  'file-snippet': (block, collapsed) => renderFileSnippet(block, block.collapsed ?? collapsed),
  'file-write': (block, collapsed) => renderFileWrite(block, block.collapsed ?? collapsed),
  'todo-list': (block) => renderTodoList(block),
  'symbol-list': (block, collapsed) => renderSymbolList(block, block.collapsed ?? collapsed),
  'grep-matches': (block, collapsed) => renderGrepMatches(block, block.collapsed ?? collapsed),
  'glob-list': (block, collapsed) => renderGlobList(block, block.collapsed ?? collapsed),
  'shell-command': (block, collapsed) => renderShellCommand(block, block.collapsed ?? collapsed),
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
