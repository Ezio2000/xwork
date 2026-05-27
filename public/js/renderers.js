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

let mermaidCounter = 0;
let mermaidInitDone = false;
const mermaidRenderCache = new Map();
const MERMAID_RENDER_CACHE_LIMIT = 80;

let echartsCounter = 0;
let echartsEventsBound = false;
const echartsInstances = new Map();

// --- Mermaid toolbar SVG icons ---
const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11"/></svg>';
const ICON_PREVIEW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ICON_ZOOM_IN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14M5 7h4M7 5v4"/></svg>';
const ICON_ZOOM_OUT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14M5 7h4"/></svg>';
const ICON_RESET = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 0 1 11.3-2.8M14 8a6 6 0 0 1-11.3 2.8"/><path d="M14 2v4h-4M2 14v-4h4"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3M3 12v1.5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5V12"/></svg>';

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

function renderDisplayMath(formula) {
  try {
    return katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false });
  } catch {
    return `<code>$$${escHtml(formula)}$$</code>`;
  }
}

function renderInlineMath(formula) {
  try {
    return katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false });
  } catch {
    return `<code>$${escHtml(formula)}$</code>`;
  }
}

function placeholder(prefix, index) {
  return `⟦${prefix}${index}⟧`;
}

function restorePlaceholders(html, prefix, values) {
  let out = html;
  for (let i = 0; i < values.length; i += 1) {
    out = out.split(placeholder(prefix, i)).join(values[i]);
  }
  return out;
}

function protectEscapedDollars(text) {
  const escapedDollars = [];
  const value = String(text || '').replace(/\\+\$/g, (match) => {
    const slashCount = match.length - 1;
    if (slashCount % 2 === 0) return match;
    escapedDollars.push('$');
    return `${'\\'.repeat(slashCount - 1)}${placeholder('DL', escapedDollars.length - 1)}`;
  });
  return { value, escapedDollars };
}

function protectDisplayMath(text) {
  let value = String(text || '');
  const displayMath = [];
  value = value.replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => {
    displayMath.push(renderDisplayMath(formula));
    return placeholder('DM', displayMath.length - 1);
  });
  return { value, displayMath };
}

function isEscaped(value, index) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function isWhitespace(value) {
  return /\s/.test(value || '');
}

function isAsciiLetterOrDigit(value) {
  return /[A-Za-z0-9]/.test(value || '');
}

function isInlineMathStart(value, index) {
  if (value[index] !== '$' || isEscaped(value, index)) return false;
  const next = value[index + 1];
  if (!next || next === '$' || next === '/' || isWhitespace(next) || /[0-9]/.test(next)) return false;
  const prev = value[index - 1];
  return !(prev && isAsciiLetterOrDigit(prev));
}

function isInlineMathEnd(value, start, index) {
  if (value[index] !== '$' || isEscaped(value, index) || index <= start + 1) return false;
  const prev = value[index - 1];
  const next = value[index + 1];
  if (isWhitespace(prev)) return false;
  return !(next && isAsciiLetterOrDigit(next));
}

function findInlineMathEnd(value, start) {
  for (let i = start + 1; i < value.length; i += 1) {
    if (value[i] === '\n') return -1;
    if (isInlineMathEnd(value, start, i)) return i;
  }
  return -1;
}

function inlineMathParts(text) {
  const value = String(text || '');
  const parts = [];
  let cursor = 0;

  for (let i = 0; i < value.length; i += 1) {
    if (!isInlineMathStart(value, i)) continue;
    const end = findInlineMathEnd(value, i);
    if (end === -1) continue;
    if (cursor < i) parts.push({ type: 'text', value: value.slice(cursor, i) });
    parts.push({ type: 'math', value: value.slice(i + 1, end) });
    cursor = end + 1;
    i = end;
  }

  if (!parts.length) return null;
  if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) });
  return parts;
}

const INLINE_MATH_SKIP_TAGS = new Set(['A', 'BUTTON', 'CODE', 'KBD', 'PRE', 'SAMP', 'SCRIPT', 'STYLE', 'TEXTAREA']);

function shouldSkipInlineMathNode(node, root) {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (INLINE_MATH_SKIP_TAGS.has(el.tagName)) return true;
  }
  return false;
}

function appendHtml(fragment, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  fragment.append(...template.content.childNodes);
}

function replaceInlineMathNode(node) {
  const parts = inlineMathParts(node.nodeValue);
  if (!parts) return;

  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (part.type === 'text') {
      fragment.append(document.createTextNode(part.value));
    } else {
      appendHtml(fragment, renderInlineMath(part.value));
    }
  }
  node.parentNode.replaceChild(fragment, node);
}

function residualStrongParts(text) {
  const value = String(text || '');
  const pattern = /\*\*([^\n]+?)\*\*/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(value))) {
    const content = match[1];
    if (!content.trim()) continue;
    if (match.index > lastIndex) parts.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    parts.push({ type: 'strong', value: content });
    lastIndex = pattern.lastIndex;
  }

  if (!parts.length) return null;
  if (lastIndex < value.length) parts.push({ type: 'text', value: value.slice(lastIndex) });
  return parts;
}

function replaceResidualStrongNode(node) {
  const parts = residualStrongParts(node.nodeValue);
  if (!parts) return;

  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (part.type === 'text') {
      fragment.append(document.createTextNode(part.value));
    } else {
      const strong = document.createElement('strong');
      strong.textContent = part.value;
      fragment.append(strong);
    }
  }
  node.parentNode.replaceChild(fragment, node);
}

function transformTextNodesInHtml(html, marker, transformNode) {
  if (!String(html || '').includes(marker)) return html;
  if (
    typeof document === 'undefined'
    || typeof document.createElement !== 'function'
    || typeof document.createTreeWalker !== 'function'
    || typeof NodeFilter === 'undefined'
  ) return html;

  const template = document.createElement('template');
  if (!template.content) return html;
  template.innerHTML = html;

  const nodes = [];
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.includes(marker)) return NodeFilter.FILTER_REJECT;
      if (shouldSkipInlineMathNode(node, template.content)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) transformNode(node);

  return template.innerHTML;
}

function renderInlineMathInHtml(html) {
  return transformTextNodesInHtml(html, '$', replaceInlineMathNode);
}

function renderResidualStrongInHtml(html) {
  return transformTextNodesInHtml(html, '**', replaceResidualStrongNode);
}

function mermaidSourceFromCode(codeEl) {
  return codeEl.textContent || '';
}

function mermaidCacheKey(source) {
  return String(source || '').trim();
}

function setMermaidCache(key, value) {
  if (!key) return;
  if (mermaidRenderCache.has(key)) mermaidRenderCache.delete(key);
  mermaidRenderCache.set(key, value);
  while (mermaidRenderCache.size > MERMAID_RENDER_CACHE_LIMIT) {
    const oldestKey = mermaidRenderCache.keys().next().value;
    mermaidRenderCache.delete(oldestKey);
  }
}

function createMermaidBlock(source, pending = false) {
  const id = `mermaid-${Date.now().toString(36)}-${mermaidCounter++}`;
  const escapedSource = escHtml(source);
  const cached = !pending ? mermaidRenderCache.get(mermaidCacheKey(source)) : null;
  const stateAttr = cached?.state === 'rendered'
    ? ' data-rendered="true"'
    : cached?.state === 'error'
      ? ' data-error="true"'
      : '';
  const renderContent = cached?.state === 'rendered'
    ? cached.svg
    : `<span class="mermaid-status">${cached?.state === 'error' ? 'Diagram could not be rendered.' : 'Rendering diagram...'}</span>`;
  const errorText = cached?.state === 'error' ? escHtml(cached.error) : '';
  return `
    <div class="mermaid-block" data-mermaid-id="${id}"${pending ? ' data-pending="true"' : ''}${stateAttr}>
      <div class="mermaid-toolbar">
        <span class="mermaid-toolbar-label">Mermaid</span>
        <button class="mermaid-btn" data-action="copy-source" title="Copy source">${ICON_COPY}<span>Copy</span></button>
        <button class="mermaid-btn" data-action="preview" title="Fullscreen preview">${ICON_PREVIEW}<span>Preview</span></button>
      </div>
      <div class="mermaid-render" id="${id}" aria-label="Mermaid diagram">
        ${renderContent}
      </div>
      <details class="mermaid-error">
        <summary>Diagram could not be rendered</summary>
        <pre>${errorText}</pre>
      </details>
      <details class="mermaid-source">
        <summary>Source</summary>
        <pre><code>${escapedSource}</code></pre>
      </details>
    </div>
  `;
}

function hasOpenTrailingMermaidFence(markdown) {
  let inFence = false;
  let inMermaidFence = false;

  for (const line of String(markdown || '').split(/\r?\n/)) {
    const fence = line.match(/^\s*```([^\s`]*)?.*$/);
    if (!fence) continue;
    if (!inFence) {
      inFence = true;
      inMermaidFence = /^mermaid$/i.test(fence[1] || '');
    } else if (/^\s*```\s*$/.test(line)) {
      inFence = false;
      inMermaidFence = false;
    }
  }

  return inFence && inMermaidFence;
}

function replaceMermaidCodeBlocks(html) {
  if (!String(html || '').includes('language-mermaid')) return html;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return html;
  const template = document.createElement('template');
  if (!template.content) return html;
  template.innerHTML = html;

  for (const code of template.content.querySelectorAll('pre > code.language-mermaid')) {
    const pre = code.parentElement;
    if (!pre) continue;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = createMermaidBlock(mermaidSourceFromCode(code));
    pre.replaceWith(wrapper.firstElementChild);
  }

  return template.innerHTML;
}

function markLastOpenMermaidBlockPending(html, markdown) {
  if (!String(markdown || '').includes('```mermaid')) return html;
  if (!String(html || '').includes('language-mermaid')) return html;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return html;
  if (!hasOpenTrailingMermaidFence(markdown)) return html;

  const template = document.createElement('template');
  if (!template.content) return html;
  template.innerHTML = html;
  const codes = template.content.querySelectorAll('pre > code.language-mermaid');
  const code = codes[codes.length - 1];
  if (!code) return html;
  const pre = code.parentElement;
  if (!pre) return html;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = createMermaidBlock(mermaidSourceFromCode(code), true);
  pre.replaceWith(wrapper.firstElementChild);
  return template.innerHTML;
}

// --- ECharts ---

function echartsSourceFromCode(code) {
  if (!code) return '';
  return code.textContent || '';
}

function hasOpenTrailingEchartsFence(markdown) {
  let inFence = false;
  let inEchartsFence = false;

  for (const line of String(markdown || '').split(/\r?\n/)) {
    const fence = line.match(/^\s*```([^\s`]*)?.*$/);
    if (!fence) continue;
    if (!inFence) {
      inFence = true;
      inEchartsFence = /^echarts$/i.test(fence[1] || '');
    } else if (/^\s*```\s*$/.test(line)) {
      inFence = false;
      inEchartsFence = false;
    }
  }

  return inFence && inEchartsFence;
}

function replaceEchartsCodeBlocks(html) {
  if (!String(html || '').includes('language-echarts')) return html;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return html;
  const template = document.createElement('template');
  if (!template.content) return html;
  template.innerHTML = html;

  for (const code of template.content.querySelectorAll('pre > code.language-echarts')) {
    const pre = code.parentElement;
    if (!pre) continue;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = createEchartsBlock(echartsSourceFromCode(code));
    pre.replaceWith(wrapper.firstElementChild);
  }

  return template.innerHTML;
}

function markLastOpenEchartsBlockPending(html, markdown) {
  if (!String(markdown || '').includes('```echarts')) return html;
  if (!String(html || '').includes('language-echarts')) return html;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return html;
  if (!hasOpenTrailingEchartsFence(markdown)) return html;

  const template = document.createElement('template');
  if (!template.content) return html;
  template.innerHTML = html;
  const codes = template.content.querySelectorAll('pre > code.language-echarts');
  const code = codes[codes.length - 1];
  if (!code) return html;
  const pre = code.parentElement;
  if (!pre) return html;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = createEchartsBlock(echartsSourceFromCode(code), true);
  pre.replaceWith(wrapper.firstElementChild);
  return template.innerHTML;
}

function createEchartsBlock(source, pending = false) {
  const id = `echarts-${Date.now().toString(36)}-${echartsCounter++}`;
  const escapedSource = escHtml(source);
  return `
    <div class="echarts-block" data-echarts-id="${id}"${pending ? ' data-pending="true"' : ''}>
      <div class="echarts-toolbar">
        <span class="echarts-toolbar-label">ECharts</span>
        <button class="echarts-btn" data-action="copy-source" title="Copy source">${ICON_COPY}<span>Copy</span></button>
        <button class="echarts-btn" data-action="download-png" title="Download as PNG">${ICON_DOWNLOAD}<span>PNG</span></button>
        <button class="echarts-btn" data-action="preview" title="Fullscreen preview">${ICON_PREVIEW}<span>Preview</span></button>
      </div>
      <div class="echarts-render" id="${id}" style="width:100%;height:400px;">
        <span class="echarts-status">Rendering chart...</span>
      </div>
      <details class="echarts-error">
        <summary>Chart could not be rendered</summary>
        <pre></pre>
      </details>
      <details class="echarts-source">
        <summary>Source</summary>
        <pre><code>${escapedSource}</code></pre>
      </details>
    </div>
  `;
}

function setEchartsError(block, message) {
  const target = block.querySelector('.echarts-render');
  const error = block.querySelector('.echarts-error');
  const errorMessage = message || 'Failed to render ECharts chart.';
  if (target) target.innerHTML = '<span class="echarts-status">Chart could not be rendered.</span>';
  if (error) {
    const pre = error.querySelector('pre');
    if (pre) pre.textContent = errorMessage;
  }
  block.dataset.error = 'true';
}

function renderEchartsBlock(block) {
  if (block.dataset.rendered === 'true' || block.dataset.rendering === 'true') return;
  const target = block.querySelector('.echarts-render');
  const source = block.querySelector('.echarts-source code')?.textContent || '';
  if (!target || !source.trim()) return;
  if (typeof echarts === 'undefined' || typeof echarts.init !== 'function') {
    setEchartsError(block, 'ECharts renderer is unavailable.');
    return;
  }

  let option;
  try {
    option = JSON.parse(source);
  } catch {
    // JSON.parse fails when the option contains JavaScript functions (e.g. formatter).
    // Fall back to evaluating as a JS expression.
    try {
      option = new Function(`return (${source})`)();
    } catch (err) {
      setEchartsError(block, `Invalid option: ${err?.message || 'parse error'}`);
      return;
    }
  }

  block.dataset.rendering = 'true';

  // After innerHTML, the element may not have been laid out yet (offsetWidth/Height=0).
  // Use requestAnimationFrame to wait for layout before initializing.
  function tryInit() {
    if (!target.isConnected) { delete block.dataset.rendering; return; }
    const w = target.offsetWidth;
    const h = target.offsetHeight;
    if (!w || !h) { requestAnimationFrame(tryInit); return; }
    // Remove loading placeholder
    const status = target.querySelector('.echarts-status');
    if (status) status.remove();
    try {
      // Dispose previous instance if re-rendering
      const prev = echartsInstances.get(target.id);
      if (prev) { try { prev.dispose(); } catch {} echartsInstances.delete(target.id); }
      const chart = echarts.init(target);
      chart.setOption(option);
      echartsInstances.set(target.id, chart);
      block.dataset.rendered = 'true';
      block.dataset.error = 'false';
      bindEchartsEvents();
    } catch (err) {
      setEchartsError(block, err?.message || 'Failed to render ECharts chart.');
    } finally {
      delete block.dataset.rendering;
    }
  }
  requestAnimationFrame(tryInit);
}

export function renderPendingEcharts(root, options = {}) {
  if (options.defer) return;
  const base = root || (typeof document !== 'undefined' ? document : null);
  if (!base?.querySelectorAll) return;
  for (const block of base.querySelectorAll('.echarts-block')) {
    if (options.closedOnly && block.dataset.pending === 'true') continue;
    renderEchartsBlock(block);
  }
}

// --- ECharts event delegation ---

function bindEchartsEvents() {
  if (echartsEventsBound || typeof document === 'undefined') return;
  echartsEventsBound = true;

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.echarts-block .echarts-btn');
    if (!btn) return;
    const block = btn.closest('.echarts-block');
    if (!block) return;
    const action = btn.dataset.action;

    if (action === 'copy-source') {
      const source = block.querySelector('.echarts-source code')?.textContent || '';
      if (source) {
        navigator.clipboard.writeText(source).then(() => {
          btn.classList.add('copied');
          const label = btn.querySelector('span');
          const old = label?.textContent;
          if (label) label.textContent = 'Copied!';
          setTimeout(() => {
            btn.classList.remove('copied');
            if (label) label.textContent = old || 'Copy';
          }, 1500);
        });
      }
    } else if (action === 'download-png') {
      const renderEl = block.querySelector('.echarts-render');
      const chart = renderEl ? echartsInstances.get(renderEl.id) : null;
      if (chart) {
        const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
        const a = document.createElement('a');
        a.href = url;
        a.download = 'echarts-chart.png';
        a.click();
      }
    } else if (action === 'preview') {
      const renderEl = block.querySelector('.echarts-render');
      const chart = renderEl ? echartsInstances.get(renderEl.id) : null;
      openEchartsPreview(chart, block.querySelector('.echarts-source code')?.textContent || '');
    }

    e.stopPropagation();
  });
}

// --- ECharts Preview Modal ---
let echartsPreviewOverlay = null;

function openEchartsPreview(chart, source) {
  closeEchartsPreview();
  const overlay = document.createElement('div');
  overlay.className = 'echarts-preview-overlay';
  overlay.innerHTML = `
    <div class="echarts-preview-header">
      <span class="echarts-preview-title">ECharts Preview</span>
      <div class="echarts-preview-actions">
        <button class="echarts-btn" data-action="download-png">${ICON_DOWNLOAD}<span>PNG</span></button>
        <button class="echarts-btn" data-action="close">${ICON_CLOSE}<span>Close</span></button>
      </div>
    </div>
    <div class="echarts-preview-body">
      <div class="echarts-preview-chart" id="echarts-preview-chart"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  echartsPreviewOverlay = overlay;

  overlay.querySelector('[data-action="close"]').addEventListener('click', closeEchartsPreview);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEchartsPreview();
  });

  overlay.querySelector('[data-action="download-png"]').addEventListener('click', () => {
    const previewChart = echartsInstances.get('echarts-preview-chart');
    if (previewChart) {
      const url = previewChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
      const a = document.createElement('a');
      a.href = url;
      a.download = 'echarts-chart.png';
      a.click();
    }
  });

  if (typeof echarts !== 'undefined' && chart) {
    try {
      const option = chart.getOption();
      const previewEl = overlay.querySelector('#echarts-preview-chart');
      previewEl.style.width = '90vw';
      previewEl.style.height = '80vh';
      const previewChart = echarts.init(previewEl);
      previewChart.setOption(option);
      echartsInstances.set('echarts-preview-chart', previewChart);
    } catch (err) {
      const previewEl = overlay.querySelector('#echarts-preview-chart');
      previewEl.innerHTML = `<span class="echarts-status">Preview failed: ${escHtml(err?.message || 'unknown error')}</span>`;
    }
  }
}

function closeEchartsPreview() {
  if (!echartsPreviewOverlay) return;
  const previewChart = echartsInstances.get('echarts-preview-chart');
  if (previewChart) {
    previewChart.dispose();
    echartsInstances.delete('echarts-preview-chart');
  }
  echartsPreviewOverlay.remove();
  echartsPreviewOverlay = null;
}

// Resize handler for ECharts instances
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  let echartsResizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(echartsResizeTimer);
    echartsResizeTimer = setTimeout(() => {
      for (const [id, chart] of echartsInstances) {
        if (id === 'echarts-preview-chart') continue;
        try { chart.resize(); } catch {}
      }
    }, 200);
  });
}

function initializeMermaid() {
  if (mermaidInitDone || typeof mermaid === 'undefined' || typeof mermaid.initialize !== 'function') return;
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true,
    securityLevel: 'strict',
    theme: 'neutral',
  });
  mermaidInitDone = true;
  bindMermaidEvents();
}

function setMermaidError(block, message) {
  const target = block.querySelector('.mermaid-render');
  const error = block.querySelector('.mermaid-error');
  const source = block.querySelector('.mermaid-source code')?.textContent || '';
  const errorMessage = message || 'Failed to render Mermaid diagram.';
  if (target) target.innerHTML = '<span class="mermaid-status">Diagram could not be rendered.</span>';
  if (error) {
    const pre = error.querySelector('pre');
    if (pre) pre.textContent = errorMessage;
  }
  block.dataset.error = 'true';
  if (source.trim()) setMermaidCache(mermaidCacheKey(source), { state: 'error', error: errorMessage });
}

function applyCachedMermaid(block, target, source, cached) {
  if (cached?.state === 'rendered') {
    target.innerHTML = cached.svg;
    block.dataset.rendered = 'true';
    delete block.dataset.error;
    return true;
  }
  if (cached?.state === 'error') {
    setMermaidError(block, cached.error);
    return true;
  }
  if (cached?.state !== 'rendering' || !cached.promise) return false;

  block.dataset.rendering = 'true';
  cached.promise
    .then(({ svg }) => {
      target.innerHTML = svg;
      block.dataset.rendered = 'true';
      setMermaidCache(mermaidCacheKey(source), { state: 'rendered', svg });
      delete block.dataset.error;
    })
    .catch((err) => {
      setMermaidError(block, err?.message || 'Failed to render Mermaid diagram.');
    })
    .finally(() => {
      delete block.dataset.rendering;
    });
  return true;
}

function renderMermaidBlock(block) {
  if (block.dataset.rendered === 'true' || block.dataset.rendering === 'true') return;
  const target = block.querySelector('.mermaid-render');
  const source = block.querySelector('.mermaid-source code')?.textContent || '';
  if (!target || !source.trim()) return;
  const cacheKey = mermaidCacheKey(source);
  if (applyCachedMermaid(block, target, source, mermaidRenderCache.get(cacheKey))) return;
  if (typeof mermaid === 'undefined' || typeof mermaid.render !== 'function') {
    setMermaidError(block, 'Mermaid renderer is unavailable.');
    return;
  }

  initializeMermaid();
  block.dataset.rendering = 'true';
  const id = target.id || `mermaid-${Date.now().toString(36)}-${mermaidCounter++}`;
  let renderPromise;
  try {
    renderPromise = Promise.resolve(mermaid.render(`${id}-svg`, source));
    setMermaidCache(cacheKey, { state: 'rendering', promise: renderPromise });
  } catch (err) {
    setMermaidError(block, err?.message || 'Failed to render Mermaid diagram.');
    delete block.dataset.rendering;
    return;
  }
  renderPromise
    .then(({ svg }) => {
      target.innerHTML = svg;
      block.dataset.rendered = 'true';
      setMermaidCache(cacheKey, { state: 'rendered', svg });
      delete block.dataset.error;
    })
    .catch((err) => {
      setMermaidError(block, err?.message || 'Failed to render Mermaid diagram.');
    })
    .finally(() => {
      delete block.dataset.rendering;
    });
}

export function renderPendingMermaid(root, options = {}) {
  if (options.defer) return;
  const base = root || (typeof document !== 'undefined' ? document : null);
  if (!base?.querySelectorAll) return;
  for (const block of base.querySelectorAll('.mermaid-block')) {
    if (options.closedOnly && block.dataset.pending === 'true') continue;
    renderMermaidBlock(block);
  }
}

// --- Mermaid Preview Modal ---
let previewOverlay = null;
let previewZoom = 1;
let previewPanX = 0;
let previewPanY = 0;

function getOrCreatePreviewOverlay() {
  if (previewOverlay) return previewOverlay;
  const overlay = document.createElement('div');
  overlay.className = 'mermaid-preview-overlay';
  overlay.innerHTML = `
    <div class="mermaid-preview-container">
      <div class="mermaid-preview-header">
        <span class="mermaid-toolbar-label">Mermaid Preview</span>
        <div class="mermaid-zoom-controls">
          <button class="mermaid-btn" data-zoom="out" title="Zoom out">${ICON_ZOOM_OUT}</button>
          <span class="mermaid-zoom-label">100%</span>
          <button class="mermaid-btn" data-zoom="in" title="Zoom in">${ICON_ZOOM_IN}</button>
          <button class="mermaid-btn" data-zoom="reset" title="Reset zoom">${ICON_RESET}</button>
        </div>
        <button class="mermaid-btn" data-action="download-svg" title="Download SVG">${ICON_DOWNLOAD}<span>SVG</span></button>
        <button class="mermaid-btn" data-action="close-preview" title="Close">${ICON_CLOSE}</button>
      </div>
      <div class="mermaid-preview-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  previewOverlay = overlay;

  // Close on overlay click (not container)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeMermaidPreview();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      closeMermaidPreview();
    }
  });

  // Mouse wheel zoom on preview body
  overlay.addEventListener('wheel', (e) => {
    if (!overlay.classList.contains('open')) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    previewZoom = Math.min(Math.max(previewZoom + delta, 0.25), 5);
    applyPreviewZoom();
  }, { passive: false });

  // Drag to pan
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragPanStartX = 0;
  let dragPanStartY = 0;

  const body = overlay.querySelector('.mermaid-preview-body');
  if (body) {
    body.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragPanStartX = previewPanX;
      dragPanStartY = previewPanY;
      body.style.cursor = 'grabbing';
      e.preventDefault();
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    previewPanX = dragPanStartX + (e.clientX - dragStartX);
    previewPanY = dragPanStartY + (e.clientY - dragStartY);
    applyPreviewZoom();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (body) body.style.cursor = 'grab';
  });

  // Zoom and action buttons
  overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('.mermaid-btn');
    if (!btn) return;
    const zoomAction = btn.dataset.zoom;
    const action = btn.dataset.action;
    if (zoomAction) {
      handlePreviewZoom(zoomAction);
    } else if (action === 'download-svg') {
      downloadPreviewSvg();
    } else if (action === 'close-preview') {
      closeMermaidPreview();
    }
  });

  return overlay;
}

function handlePreviewZoom(action) {
  if (action === 'in') previewZoom = Math.min(previewZoom + 0.25, 5);
  else if (action === 'out') previewZoom = Math.max(previewZoom - 0.25, 0.25);
  else { previewZoom = 1; previewPanX = 0; previewPanY = 0; }
  applyPreviewZoom();
}

function applyPreviewZoom() {
  if (!previewOverlay) return;
  const svg = previewOverlay.querySelector('.mermaid-preview-body svg');
  if (svg) svg.style.transform = `translate(${previewPanX}px, ${previewPanY}px) scale(${previewZoom})`;
  const label = previewOverlay.querySelector('.mermaid-zoom-label');
  if (label) label.textContent = `${Math.round(previewZoom * 100)}%`;
}

function downloadPreviewSvg() {
  if (!previewOverlay) return;
  const svg = previewOverlay.querySelector('.mermaid-preview-body svg');
  if (!svg) return;
  const svgData = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([svgData], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mermaid-diagram-${Date.now()}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

function openMermaidPreview(svgHtml, source) {
  const overlay = getOrCreatePreviewOverlay();
  const body = overlay.querySelector('.mermaid-preview-body');
  body.innerHTML = svgHtml || '<span class="mermaid-status">No diagram to preview.</span>';
  body.classList.toggle('empty', !svgHtml);
  previewZoom = 1;
  previewPanX = 0;
  previewPanY = 0;
  applyPreviewZoom();
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closeMermaidPreview() {
  if (!previewOverlay) return;
  previewOverlay.classList.remove('open');
}

// --- Mermaid toolbar & preview event delegation ---
let mermaidEventsBound = false;

function bindMermaidEvents() {
  if (mermaidEventsBound || typeof document === 'undefined') return;
  mermaidEventsBound = true;

  document.addEventListener('click', (e) => {
    // Toolbar buttons
    const btn = e.target.closest('.mermaid-block .mermaid-btn');
    if (btn) {
      const block = btn.closest('.mermaid-block');
      if (!block) return;
      const action = btn.dataset.action;
      if (action === 'copy-source') {
        const source = block.querySelector('.mermaid-source code')?.textContent || '';
        if (source) {
          navigator.clipboard.writeText(source).then(() => {
            btn.classList.add('copied');
            const label = btn.querySelector('span');
            const old = label?.textContent;
            if (label) label.textContent = 'Copied!';
            setTimeout(() => {
              btn.classList.remove('copied');
              if (label) label.textContent = old || 'Copy';
            }, 1500);
          });
        }
      } else if (action === 'preview') {
        const svgHtml = block.querySelector('.mermaid-render')?.innerHTML || '';
        const hasSvg = svgHtml.includes('<svg');
        openMermaidPreview(hasSvg ? svgHtml : null, block.querySelector('.mermaid-source code')?.textContent || '');
      }
      e.stopPropagation();
      return;
    }

    // Click on render area to open preview
    const renderArea = e.target.closest('.mermaid-block .mermaid-render');
    if (renderArea) {
      const block = renderArea.closest('.mermaid-block');
      if (!block || block.dataset.error === 'true') return;
      const svgHtml = renderArea.innerHTML;
      const hasSvg = svgHtml.includes('<svg');
      if (hasSvg) {
        openMermaidPreview(svgHtml, block.querySelector('.mermaid-source code')?.textContent || '');
      }
    }
  });
}

function normalizeMarkdownForDisplay(text) {
  let value = String(text || '').replace(/^\n+/, '');
  value = value.replace(/([一-鿿　-〿＀-￯])(\*{1,2})/g, '$1​$2');
  value = value.replace(/(\*{1,2})([一-鿿　-〿＀-￯])/g, '$1​$2');
  const match = value.match(/^\s*```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1].replace(/^\n+/, '') : value;
}

export function renderContent(text) {
  const escaped = protectEscapedDollars(normalizeMarkdownForDisplay(text));
  const display = protectDisplayMath(escaped.value);
  let html = marked.parse(display.value);
  html = markLastOpenMermaidBlockPending(html, display.value);
  html = replaceMermaidCodeBlocks(html);
  html = markLastOpenEchartsBlockPending(html, display.value);
  html = replaceEchartsCodeBlocks(html);
  html = renderResidualStrongInHtml(html);
  html = renderInlineMathInHtml(html);
  html = restorePlaceholders(html, 'DM', display.displayMath);
  html = restorePlaceholders(html, 'DL', escaped.escapedDollars);
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

function formatDirEntry(entry) {
  const indent = '  '.repeat(Math.max(0, (entry.depth || 1) - 1));
  const suffix = entry.kind === 'directory'
    ? entry.skipped ? '/' : '/'
    : entry.size != null ? ` (${entry.size} bytes)` : '';
  const skipped = entry.skipped ? ' [skipped]' : '';
  return `${indent}${entry.name}${suffix}${skipped}`;
}

function renderDirList(block, collapsed = false) {
  const path = block.path || '.';
  const entries = block.entries || [];
  const meta = [
    `${entries.length} entries`,
    block.depth ? `depth ${block.depth}` : '',
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const listing = entries.map(formatDirEntry).join('\n');

  return `
    <div class="shell-command-toggle dir-list-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">🗂️</span>
          list ${escHtml(path)}
        </span>
        <span class="shell-command-meta">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${escHtml(listing || '(empty directory)')}</code></pre>
      </div>
    </div>
  `;
}

function formatGitSummary(block) {
  const summary = block.summary || {};
  switch (block.action) {
    case 'status':
      return [
        summary.branch ? `branch ${summary.branch}` : '',
        summary.clean ? 'clean' : '',
        summary.stagedCount ? `${summary.stagedCount} staged` : '',
        summary.unstagedCount ? `${summary.unstagedCount} unstaged` : '',
        summary.untrackedCount ? `${summary.untrackedCount} untracked` : '',
      ].filter(Boolean).join(' · ');
    case 'branch':
      return [
        summary.current ? `current ${summary.current}` : '',
        summary.branchCount !== undefined ? `${summary.branchCount} branches` : '',
      ].filter(Boolean).join(' · ');
    case 'log':
    case 'reflog':
    case 'stash_list':
      return summary.commitCount !== undefined ? `${summary.commitCount} entries` : '';
    default:
      return '';
  }
}

function renderGitOutput(block, collapsed = false) {
  const action = block.action || 'git';
  const meta = [
    block.exitCode === 0 ? 'ok' : `exit ${block.exitCode ?? '?'}`,
    formatGitSummary(block),
    block.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const output = block.output || '';

  return `
    <div class="shell-command-toggle git-output-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">⎇</span>
          git ${escHtml(action)}
        </span>
        <span class="shell-command-meta">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <pre class="shell-command-output"><code>${escHtml(output || '(no output)')}</code></pre>
      </div>
    </div>
  `;
}

function renderToolRunning(block, collapsed = false) {
  const label = block.label || block.toolName || 'tool';
  const isCollapsed = block.collapsed ?? collapsed;
  const status = block.status || 'running';
  const running = status === 'running';
  const statusClass = running ? 'status-running' : status === 'error' ? 'status-error' : 'status-ok';
  const body = running
    ? '<div class="shell-terminal-running">running...</div>'
    : `<div class="shell-terminal-running">${escHtml(status)}</div>`;
  return `
    <div class="shell-command-toggle tool-running-toggle${isCollapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">⚙</span>
          ${escHtml(label)}
        </span>
        <span class="shell-command-meta ${escHtml(statusClass)}">${escHtml(status)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        ${body}
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
  const isMarkdown = block.contentFormat === 'markdown' || String(path).startsWith('feishu:');
  const contentHtml = isMarkdown
    ? `<div class="file-snippet-markdown">${renderContent(content)}</div>`
    : `<pre class="shell-command-output"><code>${escHtml(content)}</code></pre>`;

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
        ${contentHtml}
      </div>
    </div>
  `;
}

function renderFeishuAuth(block, collapsed = false) {
  const waiting = block.status !== 'completed';
  const url = block.verificationUrl || block.authorizationUrl || '';
  const meta = waiting
    ? [
      'waiting for authorization',
      block.popupOpened ? 'popup opened' : '',
      block.popupBlocked ? 'popup blocked' : '',
      block.expiresAt ? `expires ${formatDateTime(block.expiresAt)}` : '',
    ].filter(Boolean).join(' · ')
    : 'authorized';
  const message = waiting
    ? 'Complete Feishu authorization in the popup window. If it did not open, use the button below.'
    : 'Feishu authorization completed.';

  return `
    <div class="shell-command-toggle feishu-auth-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">↗</span>
          Feishu authorization
        </span>
        <span class="shell-command-meta ${waiting ? 'status-running' : 'status-ok'}">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <div class="feishu-auth-body">
          <p>${escHtml(message)}</p>
          ${url && waiting ? `<button type="button" class="btn-primary small" data-feishu-auth-url="${escHtml(url)}">Open Feishu</button>` : ''}
          ${block.popupBlocked && waiting ? '<p class="feishu-auth-warning">Your browser blocked the popup. Click Open Feishu to continue.</p>' : ''}
          ${block.deviceCode && waiting ? `<code>${escHtml(block.deviceCode)}</code>` : ''}
        </div>
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

function renderAskUserOptions(block, runId) {
  const options = Array.isArray(block.options) ? block.options : [];
  const recommended = block.recommended;
  const allowCustom = block.allowCustom === true;
  const inputType = block.kind === 'multi' ? 'checkbox' : 'radio';
  const name = block.kind === 'multi' ? 'ask-answers' : 'ask-answer';
  const items = options.map(opt => {
    const value = typeof opt === 'string' ? opt : (opt.value || opt.label || '');
    const label = typeof opt === 'string' ? opt : (opt.label || value);
    const desc = typeof opt === 'object' && opt.description ? `<span class="ask-user-option-desc">${escHtml(opt.description)}</span>` : '';
    const rec = recommended && value === recommended ? ' ask-user-option-recommended' : '';
    const checked = block.default === value || (Array.isArray(block.default) && block.default.includes(value)) ? ' checked' : '';
    return `
      <label class="ask-user-option${rec}">
        <input type="${inputType}" name="${name}" value="${escHtml(value)}"${checked}>
        <span class="ask-user-option-label">${escHtml(label)}</span>
        ${desc}
      </label>
    `;
  }).join('');
  const custom = allowCustom && block.kind === 'single' ? `
    <label class="ask-user-option">
      <input type="radio" name="ask-answer" value="__custom__">
      <span class="ask-user-option-label">其他</span>
      <input type="text" class="ask-user-custom-input" data-ask-custom placeholder="自定义…">
    </label>
  ` : '';
  return `<div class="ask-user-options">${items}${custom}</div>`;
}

function renderAskUserFields(block) {
  const fields = Array.isArray(block.fields) ? block.fields : [];
  return fields.map(field => {
    const name = escHtml(field.name || '');
    const label = escHtml(field.label || field.name || '');
    const req = field.required ? ' <span class="ask-user-required">*</span>' : '';
    const desc = field.description ? `<p class="ask-user-field-desc">${escHtml(field.description)}</p>` : '';
    const ph = field.placeholder ? ` placeholder="${escHtml(field.placeholder)}"` : '';
    let control = '';
    if (field.type === 'boolean') {
      control = `<label class="ask-user-field-bool"><input type="checkbox" data-ask-field="${name}" data-field-type="boolean"${field.default ? ' checked' : ''}> ${label}</label>`;
    } else if (field.type === 'select') {
      const opts = (field.options || []).map(opt => {
        const v = typeof opt === 'string' ? opt : opt.value;
        const l = typeof opt === 'string' ? opt : (opt.label || v);
        return `<option value="${escHtml(v)}"${field.default === v ? ' selected' : ''}>${escHtml(l)}</option>`;
      }).join('');
      control = `<label class="ask-user-field-label">${label}${req}</label><select data-ask-field="${name}" data-field-type="select"${ph}>${opts}</select>`;
    } else if (field.type === 'multiselect') {
      const opts = (field.options || []).map(opt => {
        const v = typeof opt === 'string' ? opt : opt.value;
        const l = typeof opt === 'string' ? opt : (opt.label || v);
        return `<label class="ask-user-option"><input type="checkbox" data-ask-field="${name}" data-field-type="multiselect" value="${escHtml(v)}"> ${escHtml(l)}</label>`;
      }).join('');
      control = `<div class="ask-user-field-group"><span class="ask-user-field-label">${label}${req}</span>${opts}</div>`;
    } else if (field.type === 'number') {
      const min = field.min !== undefined ? ` min="${field.min}"` : '';
      const max = field.max !== undefined ? ` max="${field.max}"` : '';
      control = `<label class="ask-user-field-label">${label}${req}</label><input type="number" data-ask-field="${name}" data-field-type="number"${ph}${min}${max} value="${field.default ?? ''}">`;
    } else {
      const sensitive = field.sensitive ? ' autocomplete="off"' : '';
      control = `<label class="ask-user-field-label">${label}${req}</label><input type="${field.sensitive ? 'password' : 'text'}" data-ask-field="${name}" data-field-type="text"${ph}${sensitive} value="${escHtml(String(field.default ?? ''))}">`;
    }
    return `<div class="ask-user-field">${control}${desc}</div>`;
  }).join('');
}

function formatAskUserAnswer(block) {
  if (block.status === 'skipped') return `已跳过${block.reason ? `（${block.reason}）` : ''}`;
  if (block.status === 'cancelled') return '已取消';
  if (block.kind === 'multi' && Array.isArray(block.answers)) return block.answers.join(', ');
  if (block.kind === 'form' && block.values) {
    return Object.entries(block.values).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
  }
  if (block.answer !== undefined && block.answer !== null) return String(block.answer);
  return '';
}

function renderAskUser(block, collapsed = false) {
  const waiting = block.status === 'waiting';
  const answered = block.status === 'answered' || block.status === 'skipped';
  const runId = block.runId || '';
  const toolCallId = block.toolCallId || '';
  const kind = block.kind || 'text';
  const contextHtml = block.context
    ? `<div class="ask-user-context">${renderContent(block.context)}</div>`
    : '';

  if (!waiting) {
    const answerText = formatAskUserAnswer(block);
    const statusLabel = block.status === 'skipped' ? '已跳过' : block.status === 'error' ? '失败' : '已回答';
    return `
      <div class="ask-user-block ask-user-${escHtml(block.status || 'answered')}${collapsed ? ' collapsed' : ''}">
        <div class="ask-user-header">
          <span class="ask-user-badge">${escHtml(statusLabel)}</span>
          <span class="ask-user-question">${escHtml(block.question || '')}</span>
        </div>
        ${contextHtml}
        ${answerText ? `<div class="ask-user-answer-summary"><strong>回答：</strong> ${escHtml(answerText)}</div>` : ''}
      </div>
    `;
  }

  let body = '';
  let actions = '';
  if (kind === 'confirm') {
    const yes = block.options?.[0]?.label || '是';
    const no = block.options?.[1]?.label || '否';
    actions = `
      <div class="ask-user-actions">
        <button type="button" class="btn-primary" data-ask-action="answer" data-ask-value="yes">${escHtml(yes)}</button>
        <button type="button" class="btn-text" data-ask-action="answer" data-ask-value="no">${escHtml(no)}</button>
        ${block.allowSkip !== false ? '<button type="button" class="btn-text ask-user-skip" data-ask-action="skip">跳过</button>' : ''}
      </div>
    `;
  } else if (kind === 'single' || kind === 'multi') {
    body = renderAskUserOptions(block, runId);
  } else if (kind === 'form') {
    body = `<div class="ask-user-fields">${renderAskUserFields(block)}</div>`;
  } else if (kind === 'number') {
    const min = block.min !== undefined ? ` min="${block.min}"` : '';
    const max = block.max !== undefined ? ` max="${block.max}"` : '';
    body = `<input type="number" class="ask-user-text-input" data-ask-number${min}${max} placeholder="${escHtml(block.placeholder || '')}" value="${block.default ?? ''}">`;
  } else {
    const multiline = block.multiline !== false;
    body = multiline
      ? `<textarea class="ask-user-text-input" data-ask-text rows="4" placeholder="${escHtml(block.placeholder || '输入回答…')}">${escHtml(String(block.default ?? ''))}</textarea>`
      : `<input type="text" class="ask-user-text-input" data-ask-text placeholder="${escHtml(block.placeholder || '输入回答…')}" value="${escHtml(String(block.default ?? ''))}">`;
  }

  const skipBtn = block.allowSkip !== false
    ? '<button type="button" class="btn-text ask-user-skip" data-ask-action="skip">跳过</button>'
    : '';
  if (!actions) {
    actions = `
      <div class="ask-user-actions">
        <button type="submit" class="btn-primary ask-user-submit">提交</button>
        ${skipBtn}
      </div>
    `;
  }

  return `
    <form class="ask-user-block ask-user-waiting" data-ask-user-form data-kind="${escHtml(kind)}" data-run-id="${escHtml(runId)}" data-tool-call-id="${escHtml(toolCallId)}">
      <div class="ask-user-header">
        <span class="ask-user-badge">需要你确认</span>
        <span class="ask-user-question">${escHtml(block.question || '')}</span>
      </div>
      ${contextHtml}
      ${body ? `<div class="ask-user-body">${body}</div>` : ''}
      ${actions}
    </form>
  `;
}

function formatAboutValue(value) {
  if (value === null || value === undefined) return '<span class="about-nil">—</span>';
  if (typeof value === 'boolean') return `<span class="about-bool">${value ? '✓' : '✗'}</span>`;
  if (typeof value === 'number') return `<span class="about-number">${value}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="about-nil">(empty)</span>';
    const isSimple = value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
    if (isSimple) {
      return `<span class="about-list">${value.map(v => `<span class="about-chip">${escHtml(String(v))}</span>`).join(' ')}</span>`;
    }
    return value.map((item, i) => {
      if (typeof item === 'object' && item !== null) {
        return `<div class="about-nested-card"><span class="about-index">#${i + 1}</span>${renderAboutPairs(item)}</div>`;
      }
      return `<div class="about-row"><span class="about-index">#${i + 1}</span><span class="about-value">${formatAboutValue(item)}</span></div>`;
    }).join('');
  }
  if (typeof value === 'object') {
    return renderAboutPairs(value);
  }
  return `<span class="about-string">${escHtml(String(value))}</span>`;
}

function renderAboutPairs(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const keys = Object.keys(obj);
  if (keys.length === 0) return '<span class="about-nil">(empty)</span>';
  return `<dl class="about-pairs">${keys.map(key => {
    const val = obj[key];
    return `<div class="about-row"><dt>${escHtml(key)}</dt><dd>${formatAboutValue(val)}</dd></div>`;
  }).join('')}</dl>`;
}

function renderAboutXwork(block, collapsed = false) {
  const query = block.query || '';
  const title = block.title || block.name || 'xwork info';
  const error = block.error || '';
  const hint = block.hint || '';
  const meta = [query, block.error ? 'error' : 'ok'].filter(Boolean).join(' · ');

  if (error) {
    return `
      <div class="shell-command-toggle about-xwork-toggle${collapsed ? ' collapsed' : ''}">
        <div class="shell-command-toggle-header" data-toggle-parent>
          <span class="shell-command-toggle-label">
            <span class="shell-command-icon">ℹ</span>
            about_xwork ${escHtml(query)}
          </span>
          <span class="shell-command-meta status-error">${escHtml(error)}</span>
          <span class="shell-command-toggle-arrow">&#9662;</span>
        </div>
        <div class="shell-command-toggle-body">
          <pre class="shell-command-output"><code>${escHtml(JSON.stringify(block, null, 2))}</code></pre>
        </div>
      </div>
    `;
  }

  const pairs = renderAboutPairs(block);

  return `
    <div class="shell-command-toggle about-xwork-toggle${collapsed ? ' collapsed' : ''}">
      <div class="shell-command-toggle-header" data-toggle-parent>
        <span class="shell-command-toggle-label">
          <span class="shell-command-icon">ℹ</span>
          ${escHtml(title)}
        </span>
        <span class="shell-command-meta">${escHtml(meta)}</span>
        <span class="shell-command-toggle-arrow">&#9662;</span>
      </div>
      <div class="shell-command-toggle-body">
        <div class="about-xwork-body">
          ${pairs}
          ${hint ? `<div class="about-hint">${escHtml(hint)}</div>` : ''}
        </div>
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
  'browser-action': (block, collapsed) => renderBrowserAction(block, block.collapsed ?? collapsed),
  'file-snippet': (block, collapsed) => renderFileSnippet(block, block.collapsed ?? collapsed),
  'feishu-auth': (block, collapsed) => renderFeishuAuth(block, block.collapsed ?? collapsed),
  'file-write': (block, collapsed) => renderFileWrite(block, block.collapsed ?? collapsed),
  'symbol-list': (block, collapsed) => renderSymbolList(block, block.collapsed ?? collapsed),
  'grep-matches': (block, collapsed) => renderGrepMatches(block, block.collapsed ?? collapsed),
  'glob-list': (block, collapsed) => renderGlobList(block, block.collapsed ?? collapsed),
  'dir-list': (block, collapsed) => renderDirList(block, block.collapsed ?? collapsed),
  'git-output': (block, collapsed) => renderGitOutput(block, block.collapsed ?? collapsed),
  'tool-running': (block, collapsed) => renderToolRunning(block, block.collapsed ?? collapsed),
  'shell-command': (block, collapsed) => renderShellCommand(block, block.collapsed ?? collapsed),
  'ask-user': (block, collapsed) => renderAskUser(block, block.collapsed ?? collapsed),
  'about-xwork': (block, collapsed) => renderAboutXwork(block, block.collapsed ?? collapsed),
};

export function renderBlocks(blocks, collapsed) {
  if (!blocks?.length) return '';
  return blocks.map(block => {
    const renderer = blockRenderers[block.type];
    return renderer ? renderer(block, collapsed) : '';
  }).join('');
}

export function installRendererEventHandlers(root = document) {
  root.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-ask-user-form]');
    if (!form || form.dataset.submitting === '1') return;
    event.preventDefault();
    const runId = form.dataset.runId;
    const toolCallId = form.dataset.toolCallId;
    if (!runId || !toolCallId) return;
    const { collectAskUserResponseFromForm, submitAskUserInput, markAskUserFormSubmitting, markAskUserFormError } = await import('./ask-user-client.js');
    try {
      const response = collectAskUserResponseFromForm(form);
      markAskUserFormSubmitting(form);
      await submitAskUserInput(runId, toolCallId, response);
    } catch (err) {
      markAskUserFormError(form, err.message || String(err));
    }
  });

  root.addEventListener('click', async (event) => {
    const answerBtn = event.target.closest('[data-ask-action="answer"]');
    if (answerBtn) {
      const form = answerBtn.closest('[data-ask-user-form]');
      if (!form || form.dataset.submitting === '1') return;
      event.preventDefault();
      const runId = form.dataset.runId;
      const toolCallId = form.dataset.toolCallId;
      if (!runId || !toolCallId) return;
      const { submitAskUserInput, markAskUserFormSubmitting, markAskUserFormError } = await import('./ask-user-client.js');
      try {
        markAskUserFormSubmitting(form);
        await submitAskUserInput(runId, toolCallId, { status: 'answered', answer: answerBtn.dataset.askValue || 'yes' });
      } catch (err) {
        markAskUserFormError(form, err.message || String(err));
      }
      return;
    }

    const skipBtn = event.target.closest('[data-ask-action="skip"]');
    if (skipBtn) {
      const form = skipBtn.closest('[data-ask-user-form]');
      if (!form || form.dataset.submitting === '1') return;
      event.preventDefault();
      const runId = form.dataset.runId;
      const toolCallId = form.dataset.toolCallId;
      if (!runId || !toolCallId) return;
      const { submitAskUserInput, markAskUserFormSubmitting, markAskUserFormError } = await import('./ask-user-client.js');
      try {
        markAskUserFormSubmitting(form);
        await submitAskUserInput(runId, toolCallId, { status: 'skipped', reason: 'user_skipped' });
      } catch (err) {
        markAskUserFormError(form, err.message || String(err));
      }
      return;
    }

    const toggle = event.target.closest('[data-toggle-parent]');
    if (toggle) {
      toggle.parentElement.classList.toggle('collapsed');
      return;
    }

    const feishuAuth = event.target.closest('[data-feishu-auth-url]');
    if (feishuAuth) {
      event.preventDefault();
      const url = feishuAuth.dataset.feishuAuthUrl;
      if (url) window.open(url, `xwork-feishu-auth-manual`, 'popup,width=960,height=760,noopener,noreferrer');
      return;
    }

    const actionCopy = event.target.closest('.action-copy');
    if (actionCopy) {
      event.preventDefault();
      const msg = actionCopy.closest('.message');
      const content = msg?.querySelector('.content');
      if (content) {
        navigator.clipboard.writeText(content.innerText).then(() => {
          actionCopy.textContent = '✓';
          setTimeout(() => { actionCopy.textContent = '⎘'; }, 1200);
        }).catch(() => {});
      }
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
