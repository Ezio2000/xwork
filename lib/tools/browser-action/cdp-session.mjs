import { startSse, writeSse } from '../../sse-writer.mjs';

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_VIEWPORT_WIDTH = 1365;
const DEFAULT_VIEWPORT_HEIGHT = 768;
const SCREENCAST_QUALITY = 72;
const INPUT_EVENT_TYPES = new Set(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']);
const INPUT_BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);

let session = {
  browser: null,
  context: null,
  page: null,
  cdp: null,
  cdpPage: null,
  screencastActive: false,
  frameId: 0,
};

const subscribers = new Set();

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch (err) {
    throw new Error(`Playwright is not available: ${err.message || String(err)}`);
  }
}

function viewportFromConfig(config = {}) {
  return {
    width: clampInteger(config.viewportWidth, DEFAULT_VIEWPORT_WIDTH, 320, 3840),
    height: clampInteger(config.viewportHeight, DEFAULT_VIEWPORT_HEIGHT, 240, 2160),
  };
}

function activePage() {
  return session.page && !session.page.isClosed() ? session.page : null;
}

async function browserState(extra = {}) {
  const page = activePage();
  if (!page) {
    return {
      type: 'state',
      status: 'idle',
      url: '',
      title: '',
      viewport: null,
      ...extra,
    };
  }
  const title = await page.title().catch(() => '');
  return {
    type: 'state',
    status: 'ready',
    url: page.url(),
    title,
    viewport: page.viewportSize(),
    ...extra,
  };
}

function broadcast(event) {
  for (const subscriber of [...subscribers]) {
    try {
      writeSse(subscriber.res, event);
    } catch {
      subscribers.delete(subscriber);
    }
  }
}

export async function publishBrowserState(extra = {}) {
  broadcast(await browserState(extra));
}

function attachPageEvents(page) {
  page.on('close', () => {
    session.page = null;
    stopScreencast().catch(() => {});
    publishBrowserState({ status: 'closed' }).catch(() => {});
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) publishBrowserState().catch(() => {});
  });
  page.on('load', () => {
    publishBrowserState().catch(() => {});
  });
}

export async function ensureBrowserPage(config = {}) {
  const existing = activePage();
  if (session.browser?.isConnected?.() && existing) {
    return existing;
  }

  await closeBrowserSession();
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: config.headless !== false,
  });
  const context = await browser.newContext({
    viewport: viewportFromConfig(config),
  });
  context.setDefaultTimeout(clampInteger(config.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 1000, 120_000));
  context.setDefaultNavigationTimeout(clampInteger(config.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS, 1000, 120_000));
  const page = await context.newPage();
  session = {
    browser,
    context,
    page,
    cdp: null,
    cdpPage: null,
    screencastActive: false,
    frameId: 0,
  };
  attachPageEvents(page);
  await publishBrowserState({ status: 'ready' });
  if (subscribers.size) await startScreencast();
  return page;
}

async function ensureCdpSession() {
  const page = activePage();
  if (!page) throw new Error('Browser page is not open');
  if (session.cdp && session.cdpPage === page) return session.cdp;

  session.cdp = await page.context().newCDPSession(page);
  session.cdpPage = page;
  session.cdp.on('Page.screencastFrame', event => {
    session.cdp?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    const currentPage = activePage();
    broadcast({
      type: 'frame',
      frameId: ++session.frameId,
      data: event.data,
      metadata: event.metadata || {},
      url: currentPage?.url?.() || '',
      viewport: currentPage?.viewportSize?.() || null,
    });
  });
  await session.cdp.send('Page.enable');
  return session.cdp;
}

export async function startScreencast() {
  if (!activePage()) return;
  const cdp = await ensureCdpSession();
  if (session.screencastActive) return;
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: SCREENCAST_QUALITY,
    everyNthFrame: 1,
  });
  session.screencastActive = true;
  await publishBrowserState({ status: 'streaming' });
}

export async function stopScreencast() {
  const cdp = session.cdp;
  if (!cdp) {
    session.screencastActive = false;
    return;
  }
  if (session.screencastActive) {
    await cdp.send('Page.stopScreencast').catch(() => {});
  }
  await cdp.detach().catch(() => {});
  session.cdp = null;
  session.cdpPage = null;
  session.screencastActive = false;
}

export async function closeBrowserSession() {
  const current = session;
  session = {
    browser: null,
    context: null,
    page: null,
    cdp: null,
    cdpPage: null,
    screencastActive: false,
    frameId: 0,
  };
  try {
    if (current.screencastActive) await current.cdp?.send?.('Page.stopScreencast');
  } catch {}
  try {
    await current.cdp?.detach?.();
  } catch {}
  try {
    await current.context?.close?.();
  } catch {}
  try {
    await current.browser?.close?.();
  } catch {}
  await publishBrowserState({ status: 'closed' });
}

export async function subscribeBrowserScreencast(req, res) {
  startSse(res);
  const subscriber = { res };
  subscribers.add(subscriber);
  writeSse(res, await browserState());
  if (activePage()) await startScreencast();

  const cleanup = () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) stopScreencast().catch(() => {});
  };
  req.on('close', cleanup);
}

function modifierMask(modifiers = {}) {
  let mask = 0;
  if (modifiers.alt) mask |= 1;
  if (modifiers.ctrl) mask |= 2;
  if (modifiers.meta) mask |= 4;
  if (modifiers.shift) mask |= 8;
  return mask;
}

function clampPoint(input, viewport) {
  const x = Number(input.x);
  const y = Number(input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('x and y must be finite numbers');
  }
  return {
    x: Math.min(Math.max(x, 0), viewport.width),
    y: Math.min(Math.max(y, 0), viewport.height),
  };
}

function keyEventType(phase, text) {
  if (phase === 'up') return 'keyUp';
  return text ? 'keyDown' : 'rawKeyDown';
}

export async function dispatchBrowserInput(input = {}) {
  const page = activePage();
  if (!page) throw new Error('Browser page is not open');
  const cdp = await ensureCdpSession();
  const kind = String(input.kind || '');
  const modifiers = modifierMask(input.modifiers || {});

  if (kind === 'mouse') {
    const type = String(input.type || '');
    if (!INPUT_EVENT_TYPES.has(type)) throw new Error('Invalid mouse input type');
    const viewport = page.viewportSize() || { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
    const point = clampPoint(input, viewport);
    const button = INPUT_BUTTONS.has(input.button) ? input.button : 'none';
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button,
      buttons: Number(input.buttons || 0),
      clickCount: clampInteger(input.clickCount, type === 'mousePressed' ? 1 : 0, 0, 5),
      deltaX: Number(input.deltaX || 0),
      deltaY: Number(input.deltaY || 0),
      modifiers,
    });
    return { ok: true };
  }

  if (kind === 'key') {
    const key = String(input.key || '');
    if (!key) throw new Error('key is required');
    const text = typeof input.text === 'string' ? input.text : '';
    await cdp.send('Input.dispatchKeyEvent', {
      type: keyEventType(input.phase, text),
      key,
      code: String(input.code || ''),
      text,
      unmodifiedText: text,
      modifiers,
      autoRepeat: input.repeat === true,
    });
    return { ok: true };
  }

  if (kind === 'insertText') {
    const text = String(input.text || '');
    if (!text) return { ok: true };
    await cdp.send('Input.insertText', { text });
    return { ok: true };
  }

  throw new Error('Invalid browser input kind');
}

export const __test = {
  viewportFromConfig,
  modifierMask,
  keyEventType,
  clampPoint,
  closeBrowserSession,
};
