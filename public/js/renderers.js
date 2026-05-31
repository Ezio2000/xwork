import {
  contentToBlocks,
  messageImages,
  mergeSources,
  messageSources,
  messageText,
  stripLeadingNewlines,
  stripSearchQueryText,
  subagentEventToBlocks,
} from './message-blocks.js';
import { getBlockRenderers, installToolEventHandlers, loadToolUiRegistry } from './tool-ui-registry.js';

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

function parseMarkdownSafeHtml(value) {
  if (typeof marked?.Renderer !== 'function') return marked.parse(value);
  const renderer = new marked.Renderer();
  renderer.html = (token) => escHtml(token?.raw ?? token?.text ?? '');
  return marked.parse(value, { renderer });
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

export function renderUserImages(images = []) {
  if (!images.length) return '';
  return `<div class="user-image-grid">${images.map(image => `
    <a class="user-image-thumb" href="${escHtml(image.url)}" target="_blank" rel="noreferrer">
      <img src="${escHtml(image.url)}" alt="${escHtml(image.filename || 'image')}">
      <span>${escHtml(image.filename || 'image')}</span>
    </a>
  `).join('')}</div>`;
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

export function disposeEchartsIn(root) {
  if (!root?.querySelectorAll) return;
  for (const target of root.querySelectorAll('.echarts-render')) {
    const chart = echartsInstances.get(target.id);
    if (!chart) continue;
    try { chart.dispose(); } catch {}
    echartsInstances.delete(target.id);
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
    htmlLabels: false,
    flowchart: {
      htmlLabels: false,
      useMaxWidth: true,
    },
  });
  mermaidInitDone = true;
  bindMermaidEvents();
}

async function waitForMermaidLayoutReady() {
  const fontReady = typeof document !== 'undefined' && document.fonts?.ready;
  if (fontReady && typeof fontReady.then === 'function') {
    try {
      await fontReady;
    } catch {}
  }
  if (typeof requestAnimationFrame === 'function') {
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
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
    renderPromise = waitForMermaidLayoutReady().then(() => mermaid.render(`${id}-svg`, source));
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
  let html = parseMarkdownSafeHtml(display.value);
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

const coreBlockRenderers = {
  text: (block) => renderContent(stripLeadingNewlines(stripSearchQueryText(block.content || ''))),
  'tool-running': (block, collapsed) => renderToolRunning(block, block.collapsed ?? collapsed),
};

function resolveBlockRenderers() {
  return { ...coreBlockRenderers, ...getBlockRenderers() };
}

export function buildToolRenderCtx() {
  return {
    escHtml,
    renderContent,
    renderBlocks: (blocks, collapsed, options) => renderBlocks(blocks, collapsed, options),
    subagentEventToBlocks,
  };
}

export function renderBlocks(blocks, collapsed, options) {
  if (!blocks?.length) return '';
  const blockRenderers = resolveBlockRenderers();
  const wrapBlocks = options?.wrapBlocks ?? false;
  return blocks.map((block, i) => {
    const renderer = blockRenderers[block.type];
    if (!renderer) return '';
    const html = renderer(block, collapsed);
    if (!wrapBlocks) return html;
    const id = getBlockStableId(block, i);
    const hash = quickHash(html);
    return `<div data-block-id="${escHtml(id)}" data-block-hash="${hash}">${html}</div>`;
  }).join('');
}

function getBlockStableId(block, index) {
  if (block.toolCallId) return `tc-${block.toolCallId}`;
  if (block.runId) return `run-${block.runId}`;
  return `blk-${index}`;
}

function quickHash(str) {
  let h = 0;
  const len = str.length;
  const step = Math.max(1, len >>> 5);
  for (let i = 0; i < len; i += step) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export async function installRendererEventHandlers(root = document) {
  const renderCtx = buildToolRenderCtx();
  await loadToolUiRegistry(renderCtx);
  await installToolEventHandlers(root, renderCtx);

  root.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-toggle-parent]');
    if (toggle) {
      toggle.parentElement.classList.toggle('collapsed');
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
  });
}
