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

export function stripSearchQueryText(text) {
  return String(text || '').replace(/^Search results for query: .*/gm, '').replace(/\n{3,}/g, '\n\n');
}

export function stripLeadingNewlines(text) {
  return String(text || '').replace(/^\n+/, '');
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

export function mergeSources(existing, incoming) {
  const out = [...existing];
  const seen = new Set(out.map(source => source.url || `${source.title}|${source.pageAge}`));
  for (const source of incoming || []) {
    if (!source || (!source.title && !source.url)) continue;
    const key = source.url || `${source.title}|${source.pageAge}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
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

function renderSubagentRun(block) {
  const status = block.status || 'running';
  const label = block.label || block.task || 'Subagent';
  const text = block.text || block.error || '';
  return `
    <div class="subagent-toggle${status === 'running' ? '' : ' collapsed'}" data-agent-run-id="${escHtml(block.runId || '')}">
      <div class="subagent-toggle-header" data-toggle-parent>
        <span class="subagent-toggle-label">${escHtml(label)}</span>
        <span class="subagent-status ${escHtml(status)}">${escHtml(status)}</span>
        <span class="subagent-toggle-arrow">▾</span>
      </div>
      <div class="subagent-toggle-body">
        ${block.task ? `<div class="subagent-task">${escHtml(block.task)}</div>` : ''}
        <div class="subagent-text">${text ? renderContent(text) : '<p>Running...</p>'}</div>
      </div>
    </div>
  `;
}

const blockRenderers = {
  'text': (block) => renderContent(stripLeadingNewlines(stripSearchQueryText(block.content || ''))),
  'source-cards': (block, collapsed) => renderSourceCards(block.sources || [], collapsed, block.searchCount || 0),
  'sources': (block, collapsed) => renderSourceCards(block.sources || [], collapsed, block.searchCount || 0),
  'uuid-list': (block) => renderUuidList(block.uuids || [], block.count || 0),
  'subagent-run': (block) => renderSubagentRun(block),
};

export function renderBlocks(blocks, collapsed) {
  if (!blocks?.length) return '';
  return blocks.map(block => {
    const renderer = blockRenderers[block.type];
    return renderer ? renderer(block, collapsed) : '';
  }).join('');
}

export function messageText(message) {
  if (Array.isArray(message.blocks)) {
    const text = message.blocks
      .filter(block => block.type === 'text')
      .map(block => block.content || '')
      .join('\n');
    return message.role === 'assistant' ? stripLeadingNewlines(stripSearchQueryText(text)) : text;
  }

  const { content } = message;
  if (typeof content === 'string') {
    return message.role === 'assistant' ? stripLeadingNewlines(stripSearchQueryText(content)) : content;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter(part => part?.type === 'text' && !part.text?.startsWith('Search results for query:'))
      .map(part => part.text || '')
      .join('\n');
    return message.role === 'assistant' ? stripLeadingNewlines(text) : text;
  }

  return '';
}

export function messageSources(message) {
  if (Array.isArray(message.blocks)) {
    return message.blocks
      .filter(block => block.type === 'source-cards' || block.type === 'sources')
      .flatMap(block => block.sources || []);
  }
  return Array.isArray(message?.sources) ? message.sources : [];
}

export function contentToBlocks(content, sourcesMeta, searchCountMeta, toolResultsMap) {
  if (!Array.isArray(content)) return null;

  const blocks = [];
  let textBuf = '';

  function flushText() {
    const contentText = stripLeadingNewlines(stripSearchQueryText(textBuf));
    if (contentText) blocks.push({ type: 'text', content: contentText });
    textBuf = '';
  }

  for (const part of content) {
    if (part.type === 'text') {
      textBuf += (textBuf ? '\n' : '') + (part.text || '');
    } else if (part.type === 'web_search_tool_result') {
      flushText();
      const items = Array.isArray(part.content) ? part.content : [];
      const sources = items
        .filter(item => item?.type === 'web_search_result')
        .map(item => ({
          title: item.title || '',
          url: item.url || '',
          pageAge: item.page_age || item.pageAge || '',
          snippet: item.snippet || item.description || item.text || '',
        }))
        .filter(source => source.title || source.url);
      if (sources.length) blocks.push({ type: 'source-cards', sources, searchCount: 1 });
    } else if (part.type === 'tool_result' && typeof part.content === 'string') {
      flushText();
      try {
        const data = JSON.parse(part.content);
        if (Array.isArray(data.uuids)) {
          blocks.push({ type: 'uuid-list', uuids: data.uuids, count: data.count ?? data.uuids.length });
        }
      } catch {}
    } else if (part.type === 'tool_use' || part.type === 'server_tool_use') {
      flushText();
      const resultBlock = toolResultsMap?.[part.id || part.tool_use_id];
      if (resultBlock) {
        blocks.push(resultBlock);
        blocks.push({ type: 'text', content: '' });
      }
    }
  }

  flushText();
  if (!blocks.some(block => block.type === 'source-cards' || block.type === 'sources')) {
    const sources = Array.isArray(sourcesMeta) ? sourcesMeta : [];
    if (sources.length && blocks.length) {
      blocks.push({ type: 'source-cards', sources, searchCount: searchCountMeta || 0 });
    }
  }

  return blocks.length ? blocks : null;
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
