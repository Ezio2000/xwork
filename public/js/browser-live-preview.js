import { dom } from './dom.js';
import { escHtml } from './renderers.js';

const HIDE_AFTER_COMPLETE_MS = 3000;

const previewState = {
  conversationId: '',
  toolCallId: '',
  action: '',
  status: '',
  url: '',
  title: '',
  screenshotUrl: '',
  screenshotPath: '',
  previewError: '',
  stepLabel: '',
  suppressedToolCallId: '',
  hideTimer: 0,
};

function previewEl() {
  return dom.browserLivePreview || null;
}

function shortUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const label = `${parsed.hostname}${path === '/' ? '' : path}`;
    return label.length > 76 ? `${label.slice(0, 73)}...` : label;
  } catch {
    return String(url).length > 76 ? `${String(url).slice(0, 73)}...` : String(url);
  }
}

function clearHideTimer() {
  if (!previewState.hideTimer) return;
  clearTimeout(previewState.hideTimer);
  previewState.hideTimer = 0;
}

function browserPreviewStatusClass() {
  const status = String(previewState.status || '').toLowerCase();
  if (status === 'error') return 'error';
  if (status === 'completed') return 'completed';
  return 'running';
}

function renderBrowserLivePreview() {
  const el = previewEl();
  if (!el) return;

  if (!previewState.toolCallId) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  const statusClass = browserPreviewStatusClass();
  const title = previewState.title || previewState.url || 'Browser';
  const meta = [
    previewState.status || 'running',
    previewState.action || 'browser',
  ].filter(Boolean).join(' · ');
  const urlLabel = shortUrl(previewState.url);
  const screenshot = previewState.screenshotUrl
    ? `<img src="${escHtml(previewState.screenshotUrl)}" alt="Live browser page">`
    : `<div class="browser-live-preview-empty">${escHtml(previewState.previewError || 'Waiting for browser page...')}</div>`;
  const openLink = previewState.screenshotUrl
    ? `<a class="browser-live-preview-link" href="${escHtml(previewState.screenshotUrl)}" target="_blank" rel="noreferrer" title="Open screenshot">Open</a>`
    : '';

  el.innerHTML = `
    <div class="browser-live-preview-head">
      <div class="browser-live-preview-title">
        <span class="browser-live-preview-dot ${escHtml(statusClass)}"></span>
        <span>${escHtml(title)}</span>
      </div>
      <div class="browser-live-preview-actions">
        ${openLink}
        <button type="button" class="browser-live-preview-close" title="Hide browser preview" aria-label="Hide browser preview">&times;</button>
      </div>
    </div>
    <div class="browser-live-preview-page">${screenshot}</div>
    <div class="browser-live-preview-foot">
      <span>${escHtml(meta)}</span>
      <span>${escHtml(urlLabel || previewState.stepLabel || '')}</span>
    </div>
  `;
  el.classList.remove('hidden');
}

function scheduleHideIfComplete() {
  clearHideTimer();
  if (!['completed', 'error'].includes(String(previewState.status || '').toLowerCase())) return;
  previewState.hideTimer = setTimeout(() => {
    previewState.hideTimer = 0;
    hideBrowserLivePreview();
  }, HIDE_AFTER_COMPLETE_MS);
  previewState.hideTimer.unref?.();
}

export function updateBrowserLivePreview(event = {}, { conversationId = '' } = {}) {
  if (event.name !== 'browser_action' || !event.id) return;
  if (event.closed || event.action === 'close') {
    hideBrowserLivePreview({ conversationId });
    return;
  }
  if (previewState.suppressedToolCallId === event.id) return;
  clearHideTimer();
  previewState.conversationId = conversationId;
  previewState.toolCallId = event.id;
  previewState.action = event.action || previewState.action || event.input?.action || 'browser';
  previewState.status = event.status || (event.phase === 'complete' ? 'completed' : event.phase === 'error' ? 'error' : 'running');
  previewState.url = event.url || previewState.url || event.input?.url || '';
  previewState.title = event.title || previewState.title || '';
  previewState.stepLabel = event.label || `${event.phase || 'running'} ${previewState.action}`.trim();
  previewState.previewError = event.previewError || previewState.previewError || '';
  previewState.screenshotUrl = event.previewScreenshotUrl || event.screenshotUrl || previewState.screenshotUrl || '';
  previewState.screenshotPath = event.previewScreenshotPath || event.screenshotPath || previewState.screenshotPath || '';
  renderBrowserLivePreview();
  scheduleHideIfComplete();
}

export function completeBrowserLivePreview(tool = {}, { conversationId = '' } = {}) {
  if (tool.name !== 'browser_action' || !tool.id) return;
  const data = tool.data || {};
  if (data.closed || data.action === 'close') {
    hideBrowserLivePreview({ conversationId });
    return;
  }
  updateBrowserLivePreview({
    id: tool.id,
    name: tool.name,
    phase: tool.isError ? 'error' : 'complete',
    status: tool.isError ? 'error' : 'completed',
    action: data.action,
    url: data.url,
    title: data.title,
    screenshotUrl: data.screenshotUrl,
    screenshotPath: data.screenshotPath,
    previewScreenshotUrl: data.previewScreenshotUrl,
    previewScreenshotPath: data.previewScreenshotPath,
    previewError: data.previewError || (tool.isError ? String(tool.output || 'Browser action failed') : ''),
  }, { conversationId });
}

export function hideBrowserLivePreview({ conversationId = '' } = {}) {
  if (conversationId && previewState.conversationId && previewState.conversationId !== conversationId) return;
  clearHideTimer();
  previewState.toolCallId = '';
  previewState.suppressedToolCallId = '';
  const el = previewEl();
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';
}

export function bindBrowserLivePreview() {
  const el = previewEl();
  if (!el || el.dataset.bound === 'true') return;
  el.dataset.bound = 'true';
  el.addEventListener('click', (event) => {
    const close = event.target.closest?.('.browser-live-preview-close');
    if (!close) return;
    previewState.suppressedToolCallId = previewState.toolCallId || '';
    clearHideTimer();
    previewState.toolCallId = '';
    el.classList.add('hidden');
    el.innerHTML = '';
  });
}

export const __test = {
  previewState,
  shortUrl,
  renderBrowserLivePreview,
};
