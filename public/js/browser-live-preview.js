import { api } from './api-client.js';
import { dom } from './dom.js';

const STREAM_URL = '/api/v1/browser-live/stream';
const INPUT_URL = '/api/v1/browser-live/input';
const HIDE_AFTER_CLOSE_MS = 1200;

const previewState = {
  conversationId: '',
  toolCallId: '',
  action: '',
  status: 'idle',
  url: '',
  title: '',
  viewport: null,
  connected: false,
  visible: false,
  suppressed: false,
  frameId: 0,
  eventSource: null,
  hideTimer: 0,
  mouseButtons: 0,
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
  if (status === 'closed' || status === 'error') return 'error';
  if (status === 'streaming' || status === 'ready') return 'running';
  return 'idle';
}

function ensurePreviewShell() {
  const el = previewEl();
  if (!el) return null;
  if (el.dataset.rendered === 'true') return el;
  el.dataset.rendered = 'true';
  el.tabIndex = 0;
  el.innerHTML = `
    <div class="browser-live-preview-head">
      <div class="browser-live-preview-title">
        <span class="browser-live-preview-dot idle" data-browser-live-dot></span>
        <span data-browser-live-title>Browser</span>
      </div>
      <div class="browser-live-preview-actions">
        <button type="button" class="browser-live-preview-close" title="Hide browser" aria-label="Hide browser">&times;</button>
      </div>
    </div>
    <div class="browser-live-preview-page">
      <canvas class="browser-live-preview-canvas" data-browser-live-canvas></canvas>
      <div class="browser-live-preview-empty" data-browser-live-empty>Waiting for browser...</div>
    </div>
    <div class="browser-live-preview-foot">
      <span data-browser-live-status>idle</span>
      <span data-browser-live-url></span>
    </div>
  `;
  return el;
}

function updatePreviewChrome() {
  const el = ensurePreviewShell();
  if (!el) return;
  const title = previewState.title || previewState.url || 'Browser';
  const meta = [
    previewState.connected ? previewState.status || 'streaming' : 'connecting',
    previewState.action || 'browser',
  ].filter(Boolean).join(' · ');
  el.querySelector('[data-browser-live-title]').textContent = title;
  el.querySelector('[data-browser-live-status]').textContent = meta;
  el.querySelector('[data-browser-live-url]').textContent = shortUrl(previewState.url);
  const dot = el.querySelector('[data-browser-live-dot]');
  dot.className = `browser-live-preview-dot ${browserPreviewStatusClass()}`;
}

function showPreview() {
  if (previewState.suppressed) return;
  const el = ensurePreviewShell();
  if (!el) return;
  previewState.visible = true;
  el.classList.remove('hidden');
  updatePreviewChrome();
  connectScreencast();
}

function scheduleHide() {
  clearHideTimer();
  previewState.hideTimer = setTimeout(() => {
    previewState.hideTimer = 0;
    hideBrowserLivePreview();
  }, HIDE_AFTER_CLOSE_MS);
  previewState.hideTimer.unref?.();
}

function connectScreencast() {
  if (previewState.eventSource || typeof EventSource === 'undefined') return;
  const source = new EventSource(STREAM_URL);
  previewState.eventSource = source;
  source.onopen = () => {
    previewState.connected = true;
    updatePreviewChrome();
  };
  source.onerror = () => {
    previewState.connected = false;
    updatePreviewChrome();
  };
  source.onmessage = event => {
    try {
      applyScreencastEvent(JSON.parse(event.data));
    } catch {}
  };
}

function disconnectScreencast() {
  previewState.eventSource?.close?.();
  previewState.eventSource = null;
  previewState.connected = false;
}

function canvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const viewport = previewState.viewport || { width: canvas.width || rect.width, height: canvas.height || rect.height };
  const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * viewport.width;
  const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * viewport.height;
  return { x, y };
}

function mouseButton(event) {
  if (event.button === 1) return 'middle';
  if (event.button === 2) return 'right';
  return 'left';
}

function mouseButtonMask(event) {
  if (event.button === 1) return 4;
  if (event.button === 2) return 2;
  return 1;
}

function printableKeyText(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return '';
  return event.key.length === 1 ? event.key : '';
}

function modifierPayload(event) {
  return {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
}

function sendBrowserInput(payload) {
  return api('POST', INPUT_URL, payload).catch(() => {});
}

function dispatchMouse(event, type) {
  const canvas = event.currentTarget;
  const point = canvasPoint(event, canvas);
  const buttonMask = mouseButtonMask(event);
  if (type === 'mousePressed') previewState.mouseButtons |= buttonMask;
  if (type === 'mouseReleased') previewState.mouseButtons &= ~buttonMask;
  sendBrowserInput({
    kind: 'mouse',
    type,
    x: point.x,
    y: point.y,
    button: type === 'mouseMoved' ? 'none' : mouseButton(event),
    buttons: previewState.mouseButtons,
    clickCount: type === 'mousePressed' ? 1 : 0,
    modifiers: modifierPayload(event),
  });
}

function dispatchWheel(event) {
  const point = canvasPoint(event, event.currentTarget);
  sendBrowserInput({
    kind: 'mouse',
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: previewState.mouseButtons,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    modifiers: modifierPayload(event),
  });
}

function drawFrame(event) {
  const el = ensurePreviewShell();
  if (!el || !event.data) return;
  const canvas = el.querySelector('[data-browser-live-canvas]');
  const empty = el.querySelector('[data-browser-live-empty]');
  const image = new Image();
  image.onload = () => {
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.hidden = false;
    empty.hidden = true;
  };
  image.src = `data:image/jpeg;base64,${event.data}`;
}

export function applyScreencastEvent(event = {}) {
  if (event.type === 'state') {
    previewState.status = event.status || previewState.status;
    previewState.url = event.url || previewState.url || '';
    previewState.title = event.title || previewState.title || '';
    previewState.viewport = event.viewport || previewState.viewport;
    if (event.status === 'closed') scheduleHide();
    updatePreviewChrome();
    return;
  }
  if (event.type === 'frame') {
    previewState.frameId = Number(event.frameId || previewState.frameId + 1);
    previewState.status = 'streaming';
    previewState.url = event.url || previewState.url;
    previewState.viewport = event.viewport || (
      event.metadata?.deviceWidth
        ? { width: event.metadata.deviceWidth, height: event.metadata.deviceHeight }
        : previewState.viewport
    );
    drawFrame(event);
    updatePreviewChrome();
  }
}

export function updateBrowserLivePreview(event = {}, { conversationId = '' } = {}) {
  if (event.name !== 'browser_action' || !event.id) return;
  if (event.closed || event.action === 'close') {
    previewState.status = 'closed';
    scheduleHide();
    updatePreviewChrome();
    return;
  }
  clearHideTimer();
  previewState.conversationId = conversationId;
  previewState.toolCallId = event.id;
  previewState.action = event.action || previewState.action || event.input?.action || 'browser';
  previewState.status = event.status || (event.phase === 'complete' ? 'streaming' : 'running');
  previewState.url = event.url || previewState.url || event.input?.url || '';
  previewState.title = event.title || previewState.title || '';
  previewState.suppressed = false;
  showPreview();
}

export function completeBrowserLivePreview(tool = {}, { conversationId = '' } = {}) {
  if (tool.name !== 'browser_action' || !tool.id) return;
  const data = tool.data || {};
  updateBrowserLivePreview({
    id: tool.id,
    name: tool.name,
    phase: tool.isError ? 'error' : 'complete',
    status: tool.isError ? 'error' : 'streaming',
    action: data.action,
    url: data.url,
    title: data.title,
    closed: data.closed,
  }, { conversationId });
}

export function hideBrowserLivePreview({ conversationId = '' } = {}) {
  if (conversationId && previewState.conversationId && previewState.conversationId !== conversationId) return;
  clearHideTimer();
  previewState.visible = false;
  previewState.toolCallId = '';
  disconnectScreencast();
  const el = previewEl();
  if (el) el.classList.add('hidden');
}

export function bindBrowserLivePreview() {
  const el = ensurePreviewShell();
  if (!el || el.dataset.bound === 'true') return;
  el.dataset.bound = 'true';
  const canvas = el.querySelector('[data-browser-live-canvas]');
  canvas.hidden = true;

  el.addEventListener('click', (event) => {
    const close = event.target.closest?.('.browser-live-preview-close');
    if (!close) return;
    previewState.suppressed = true;
    hideBrowserLivePreview();
  });

  canvas.addEventListener('pointermove', event => {
    event.preventDefault();
    dispatchMouse(event, 'mouseMoved');
  });
  canvas.addEventListener('pointerdown', event => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    el.focus();
    dispatchMouse(event, 'mousePressed');
  });
  canvas.addEventListener('pointerup', event => {
    event.preventDefault();
    dispatchMouse(event, 'mouseReleased');
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    dispatchWheel(event);
  }, { passive: false });
  canvas.addEventListener('contextmenu', event => {
    event.preventDefault();
  });
  el.addEventListener('keydown', event => {
    if (!previewState.visible) return;
    event.preventDefault();
    sendBrowserInput({
      kind: 'key',
      phase: 'down',
      key: event.key,
      code: event.code,
      text: printableKeyText(event),
      repeat: event.repeat,
      modifiers: modifierPayload(event),
    });
  });
  el.addEventListener('keyup', event => {
    if (!previewState.visible) return;
    event.preventDefault();
    sendBrowserInput({
      kind: 'key',
      phase: 'up',
      key: event.key,
      code: event.code,
      modifiers: modifierPayload(event),
    });
  });
  el.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!text) return;
    event.preventDefault();
    sendBrowserInput({ kind: 'insertText', text });
  });
}

export const __test = {
  previewState,
  shortUrl,
  canvasPoint,
  mouseButtonMask,
  printableKeyText,
  applyScreencastEvent,
};
