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
  return `
    <div class="subagent-toggle${runCollapsed ? ' collapsed' : ''}" data-agent-run-id="${escHtml(block.runId || '')}">
      <div class="subagent-toggle-header" data-toggle-parent>
        <span class="subagent-toggle-label">${escHtml(label)}</span>
        <span class="subagent-status ${escHtml(status)}">${escHtml(status)}</span>
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

function codeBlock(label, value) {
  const content = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  const escapedFence = content.replace(/```/g, '`\\`\\`');
  return `**${label}**\n\n\`\`\`json\n${escapedFence}\n\`\`\``;
}

function renderBlockFromResult(renderType, data) {
  if (!renderType || !data) return null;
  return { type: renderType, ...data };
}

function renderBlockFromOutput(output) {
  if (!output || typeof output !== 'object') return null;
  if (Array.isArray(output.sources) && output.sources.length) {
    return { type: 'source-cards', sources: output.sources, searchCount: output.searchCount || 0 };
  }
  if (Array.isArray(output.uuids)) {
    return { type: 'uuid-list', uuids: output.uuids, count: output.count ?? output.uuids.length };
  }
  return null;
}

export function subagentEventToBlocks(event) {
  const type = event.eventType || event.type || event.event || '';
  if (type === 'subagent_delta' || type === 'subagent_thinking' || type === 'subagent_start' || type === 'subagent_tool_call') return [];

  if (type === 'subagent_tool_result') {
    const rendered = renderBlockFromResult(event.renderType, event.data) || renderBlockFromOutput(event.output);
    if (rendered) return [rendered];
    const output = event.isError ? (event.output || event.error || 'Tool error') : (event.output ?? `${Number(event.durationMs || 0)}ms`);
    return [{ type: 'text', content: codeBlock(`Tool result · ${event.name || 'tool'}`, output) }];
  }

  if (type === 'subagent_server_tool') {
    const serverEvent = event.event || {};
    const name = serverEvent.name || event.name || 'server tool';
    if (serverEvent.phase === 'call') {
      return [];
    }
    if (serverEvent.phase === 'result') {
      const rendered = renderBlockFromResult(serverEvent.renderType, serverEvent.data) || renderBlockFromOutput(serverEvent.data);
      if (rendered) return [rendered];
      return [{ type: 'text', content: codeBlock(`Server tool result · ${name}`, serverEvent.data || serverEvent.errorCode || {}) }];
    }
  }

  if (type === 'subagent_done' && event.error) {
    return [{ type: 'text', content: `**Subagent error**\n\n${event.error}` }];
  }

  return [];
}

const blockRenderers = {
  'text': (block) => renderContent(stripLeadingNewlines(stripSearchQueryText(block.content || ''))),
  'source-cards': (block, collapsed) => renderSourceCards(block.sources || [], collapsed, block.searchCount || 0),
  'sources': (block, collapsed) => renderSourceCards(block.sources || [], collapsed, block.searchCount || 0),
  'uuid-list': (block) => renderUuidList(block.uuids || [], block.count || 0),
  'subagent-run': (block, collapsed) => renderSubagentRun(block, collapsed),
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
