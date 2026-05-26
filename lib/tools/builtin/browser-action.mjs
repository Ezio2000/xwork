import { mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getProjectRoot } from '../../workspace-root.mjs';

const ACTIONS = new Set(['open', 'click', 'type', 'press', 'wait_for', 'locate', 'text', 'screenshot', 'evaluate', 'state', 'close']);
const WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
const WAIT_STATES = new Set(['attached', 'detached', 'visible', 'hidden']);
const MAX_SELECTOR_LENGTH = 1000;
const MAX_TEXT_LENGTH = 10_000;
const MAX_SCRIPT_LENGTH = 4000;
const MAX_RESULT_CHARS = 20_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_CHARS = 5000;
const DEFAULT_VIEWPORT_WIDTH = 1365;
const DEFAULT_VIEWPORT_HEIGHT = 768;
const DEFAULT_SCREENSHOT_DIR = 'data/browser-screenshots';
const SCREENSHOT_ROUTE_BASE = '/api/v1/tool-assets/browser-screenshots';

let session = {
  browser: null,
  context: null,
  page: null,
};

function systemPrompt() {
  return [
    '# Browser Tool Policy',
    'browser_action controls a Playwright Chromium page for browser-based inspection and UI testing.',
    '- Prefer selectors over coordinates. Use stable CSS selectors, labels, roles, or visible text when available.',
    '- Use it for local app verification, screenshots, page text extraction, and browser-only interactions.',
    '- Do not use it for payments, irreversible account actions, sending messages, changing security settings, or entering secrets unless the user explicitly requests that exact action.',
    '- If a browser action may alter external state, explain the risk before calling the tool.',
  ].join('\n');
}

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function ensureString(value, name, max, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (value.length > max) throw new Error(`${name} is too long`);
}

function validateHttpUrl(value) {
  ensureString(value, 'url', 3000);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('url must use http or https');
  }
  return parsed;
}

function normalizeHostPattern(pattern) {
  return String(pattern || '').trim().toLowerCase();
}

function hostMatches(hostname, pattern) {
  const normalized = normalizeHostPattern(pattern);
  if (!normalized) return false;
  const host = String(hostname || '').toLowerCase();
  if (normalized === '*') return true;
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(1);
    return host.endsWith(suffix) || host === normalized.slice(2);
  }
  return host === normalized;
}

function assertAllowedUrl(url, config = {}) {
  const allowedHosts = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];
  const blockedHosts = Array.isArray(config.blockedHosts) ? config.blockedHosts : [];
  if (blockedHosts.some(pattern => hostMatches(url.hostname, pattern))) {
    throw new Error(`Blocked browser host: ${url.hostname}`);
  }
  if (allowedHosts.length && !allowedHosts.some(pattern => hostMatches(url.hostname, pattern))) {
    throw new Error(`Host is not allowed for browser_action: ${url.hostname}`);
  }
}

function screenshotDir(config = {}) {
  const dir = typeof config.screenshotDir === 'string' && config.screenshotDir.trim()
    ? config.screenshotDir.trim()
    : DEFAULT_SCREENSHOT_DIR;
  const projectRoot = getProjectRoot();
  const resolved = isAbsolute(dir) ? resolve(dir) : resolve(projectRoot, dir);
  const rel = relative(projectRoot, resolved);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('screenshotDir must stay inside the xwork project root');
  }
  return resolved;
}

function screenshotFilename(name) {
  if (name !== undefined) {
    ensureString(name, 'screenshotName', 120);
    const withoutExt = name.replace(/\.png$/i, '');
    const sanitized = withoutExt
      .replace(/[\\/]+/g, '-')
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 80);
    return `${sanitized || `browser-${randomUUID().slice(0, 8)}`}.png`;
  }
  return `browser-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
}

function screenshotUrlFromPath(path) {
  const filename = String(path || '').split(/[\\/]/).pop();
  if (!filename || !/^[a-zA-Z0-9_.-]+\.png$/i.test(filename)) return '';
  return `${SCREENSHOT_ROUTE_BASE}/${encodeURIComponent(filename)}`;
}

function truncateText(text, maxChars = DEFAULT_MAX_TEXT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

function safeJsonPreview(value, maxChars = DEFAULT_MAX_TEXT_CHARS) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return truncateText(text, maxChars);
}

function inputTimeout(input, config, key, fallback) {
  return clampInteger(
    input.timeoutMs ?? config?.[key],
    fallback,
    1000,
    120_000,
  );
}

function assertIntegerRange(value, name, min, max) {
  if (value === undefined) return;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

function inputMaxText(input, config) {
  return clampInteger(
    input.maxTextChars ?? config?.maxTextChars,
    DEFAULT_MAX_TEXT_CHARS,
    500,
    MAX_RESULT_CHARS,
  );
}

async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch (err) {
    throw new Error(`Playwright is not available: ${err.message || String(err)}`);
  }
}

async function ensurePage(config = {}) {
  if (session.browser?.isConnected?.() && session.page && !session.page.isClosed()) {
    return session.page;
  }

  await closeSession();
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: config.headless !== false,
  });
  const context = await browser.newContext({
    viewport: {
      width: clampInteger(config.viewportWidth, DEFAULT_VIEWPORT_WIDTH, 320, 3840),
      height: clampInteger(config.viewportHeight, DEFAULT_VIEWPORT_HEIGHT, 240, 2160),
    },
  });
  context.setDefaultTimeout(clampInteger(config.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 1000, 120_000));
  context.setDefaultNavigationTimeout(clampInteger(config.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS, 1000, 120_000));
  const page = await context.newPage();
  session = { browser, context, page };
  return page;
}

async function closeSession() {
  const current = session;
  session = { browser: null, context: null, page: null };
  try {
    await current.context?.close?.();
  } catch {}
  try {
    await current.browser?.close?.();
  } catch {}
}

async function pageSnapshot(page, action, extra = {}) {
  const title = page && !page.isClosed() ? await page.title().catch(() => '') : '';
  const url = page && !page.isClosed() ? page.url() : '';
  return {
    action,
    url,
    title,
    ...extra,
  };
}

function targetLocator(page, input) {
  if (input.selector) {
    return {
      locator: page.locator(input.selector),
      selector: input.selector,
    };
  }
  return {
    locator: page.getByText(input.text),
    textQuery: input.text,
  };
}

function emitStep(emit, event) {
  emit?.({
    stream: 'browser',
    ...event,
    ts: new Date().toISOString(),
  });
}

async function evaluateScript(page, source) {
  return page.evaluate(async (script) => {
    try {
      const expression = new Function(`return (${script});`);
      return await expression();
    } catch {
      const statement = new Function(script);
      return await statement();
    }
  }, source);
}

export const browserActionTool = {
  id: 'browser_action',
  name: 'browser_action',
  title: 'Browser Action',
  description: 'Control a Playwright Chromium browser page for cross-platform web UI inspection. Supports opening pages, clicking, typing, pressing keys, waiting for selectors, reading text, taking screenshots, evaluating browser JavaScript, checking state, and closing the browser. Use selectors rather than coordinates.',
  category: 'web',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'high',
  defaultEnabled: true,
  timeoutMs: 120000,
  defaultConfig: {
    headless: true,
    viewportWidth: DEFAULT_VIEWPORT_WIDTH,
    viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
    navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
    actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    maxTextChars: DEFAULT_MAX_TEXT_CHARS,
    screenshotDir: DEFAULT_SCREENSHOT_DIR,
    allowedHosts: [],
    blockedHosts: [],
  },
  configSchema: {
    type: 'object',
    properties: {
      headless: { type: 'boolean', description: 'Run Chromium without a visible browser window. Recommended for servers and automated checks.' },
      viewportWidth: { type: 'number', description: 'Browser viewport width in pixels.' },
      viewportHeight: { type: 'number', description: 'Browser viewport height in pixels.' },
      navigationTimeoutMs: { type: 'number', description: 'Default timeout for page navigation.' },
      actionTimeoutMs: { type: 'number', description: 'Default timeout for selector actions.' },
      maxTextChars: { type: 'number', description: 'Maximum characters returned for text/evaluate results.' },
      screenshotDir: { type: 'string', description: 'Workspace-relative directory where screenshots are written.' },
      allowedHosts: { type: 'array', description: 'Optional host allowlist. Supports exact hosts and *.example.com patterns.' },
      blockedHosts: { type: 'array', description: 'Optional host blocklist. Supports exact hosts and *.example.com patterns.' },
    },
    additionalProperties: false,
  },
  configExamples: [
    {
      title: 'Local app testing',
      config: {
        headless: true,
        viewportWidth: 1440,
        viewportHeight: 900,
        navigationTimeoutMs: 30000,
        actionTimeoutMs: 10000,
        maxTextChars: 8000,
        screenshotDir: 'data/browser-screenshots',
        allowedHosts: ['localhost', '127.0.0.1'],
        blockedHosts: [],
      },
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: 'Browser action to perform: open, click, type, press, wait_for, locate, text, screenshot, evaluate, state, or close.',
      },
      url: {
        type: 'string',
        description: 'URL for action=open. Must use http or https.',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for click/type/wait_for/locate/text actions. For click/locate, visible text can be used instead when selector is omitted. If omitted for text, the page body is read. If omitted for wait_for, waitUntil is used to wait for page load state.',
      },
      text: {
        type: 'string',
        description: 'Text to type for action=type, or visible text to find for action=click/locate when selector is omitted.',
      },
      key: {
        type: 'string',
        description: 'Keyboard key for action=press, for example Enter, Escape, Meta+L, or Control+A.',
      },
      script: {
        type: 'string',
        description: 'Browser JavaScript for action=evaluate. Runs in the page context and should return JSON-serializable data.',
      },
      waitUntil: {
        type: 'string',
        enum: [...WAIT_UNTIL],
        description: 'Navigation wait condition for action=open.',
      },
      waitState: {
        type: 'string',
        enum: [...WAIT_STATES],
        description: 'Selector state for action=wait_for.',
      },
      clear: {
        type: 'boolean',
        description: 'For action=type, fill the field instead of appending text. Defaults to true.',
      },
      fullPage: {
        type: 'boolean',
        description: 'For action=screenshot, capture the full scrollable page.',
      },
      screenshotName: {
        type: 'string',
        description: 'Optional PNG filename for action=screenshot. Must not contain path separators.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional timeout for this action in milliseconds.',
      },
      maxTextChars: {
        type: 'number',
        description: 'Optional maximum characters for text/evaluate output.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },

  systemPrompt,

  validate(input) {
    if (!input || typeof input !== 'object') throw new Error('input is required');
    if (!ACTIONS.has(input.action)) throw new Error(`Unsupported browser action: ${input.action}`);
    if (input.url !== undefined) validateHttpUrl(input.url);
    if (input.selector !== undefined) ensureString(input.selector, 'selector', MAX_SELECTOR_LENGTH);
    if (input.text !== undefined) ensureString(input.text, 'text', MAX_TEXT_LENGTH, { required: false });
    if (input.key !== undefined) ensureString(input.key, 'key', 120);
    if (input.script !== undefined) ensureString(input.script, 'script', MAX_SCRIPT_LENGTH);
    if (input.waitUntil !== undefined && !WAIT_UNTIL.has(input.waitUntil)) throw new Error('Invalid waitUntil value');
    if (input.waitState !== undefined && !WAIT_STATES.has(input.waitState)) throw new Error('Invalid waitState value');
    assertIntegerRange(input.timeoutMs, 'timeoutMs', 1000, 120_000);
    assertIntegerRange(input.maxTextChars, 'maxTextChars', 500, MAX_RESULT_CHARS);

    if (input.action === 'open' && !input.url) throw new Error('url is required for action=open');
    if (input.action === 'type' && !input.selector) {
      throw new Error(`selector is required for action=${input.action}`);
    }
    if (['click', 'locate'].includes(input.action) && !input.selector && !input.text) {
      throw new Error(`selector or text is required for action=${input.action}`);
    }
    if (input.action === 'wait_for' && !input.selector && !input.waitUntil) {
      throw new Error('selector or waitUntil is required for action=wait_for');
    }
    if (input.action === 'type' && input.text === undefined) throw new Error('text is required for action=type');
    if (input.action === 'press' && !input.key) throw new Error('key is required for action=press');
    if (input.action === 'evaluate' && !input.script) throw new Error('script is required for action=evaluate');
    if (input.screenshotName !== undefined) screenshotFilename(input.screenshotName);
  },

  async handler(input, { config, signal, emit }) {
    const action = input.action;
    const maxTextChars = inputMaxText(input, config);
    const actionTimeout = inputTimeout(input, config, 'actionTimeoutMs', DEFAULT_ACTION_TIMEOUT_MS);
    emitStep(emit, {
      phase: 'start',
      action,
      url: input.url,
      selector: input.selector,
      key: input.key,
      waitUntil: input.waitUntil,
      waitState: input.waitState,
      fullPage: input.fullPage === true,
    });

    if (action === 'close') {
      await closeSession();
      emitStep(emit, { phase: 'complete', action, closed: true });
      return { action, closed: true };
    }

    const page = await ensurePage(config);
    if (signal?.aborted) throw new Error('Browser action aborted');

    if (action === 'open') {
      const url = validateHttpUrl(input.url);
      assertAllowedUrl(url, config);
      const response = await page.goto(url.toString(), {
        waitUntil: input.waitUntil || 'domcontentloaded',
        timeout: inputTimeout(input, config, 'navigationTimeoutMs', DEFAULT_NAVIGATION_TIMEOUT_MS),
      });
      const output = await pageSnapshot(page, action, {
        statusCode: response?.status?.() || null,
      });
      emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title, statusCode: output.statusCode });
      return output;
    }

    if (action === 'click') {
      const target = targetLocator(page, input);
      await target.locator.first().click({ timeout: actionTimeout });
      const output = await pageSnapshot(page, action, { selector: target.selector, textQuery: target.textQuery });
      emitStep(emit, {
        phase: 'complete',
        action,
        url: output.url,
        title: output.title,
        selector: target.selector,
        textQuery: target.textQuery,
      });
      return output;
    }

    if (action === 'type') {
      const locator = page.locator(input.selector).first();
      if (input.clear === false) {
        await locator.pressSequentially(input.text, { timeout: actionTimeout });
      } else {
        await locator.fill(input.text, { timeout: actionTimeout });
      }
      const output = await pageSnapshot(page, action, { selector: input.selector, textLength: input.text.length });
      emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title, selector: input.selector, textLength: input.text.length });
      return output;
    }

    if (action === 'press') {
      await page.keyboard.press(input.key);
      const output = await pageSnapshot(page, action, { key: input.key });
      emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title, key: input.key });
      return output;
    }

    if (action === 'wait_for') {
      if (input.selector) {
        await page.locator(input.selector).first().waitFor({
          state: input.waitState || 'visible',
          timeout: actionTimeout,
        });
        const output = await pageSnapshot(page, action, { selector: input.selector, waitState: input.waitState || 'visible' });
        emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title, selector: input.selector, waitState: output.waitState });
        return output;
      }
      const waitUntil = input.waitUntil || 'domcontentloaded';
      await page.waitForLoadState(waitUntil, { timeout: actionTimeout });
      const output = await pageSnapshot(page, action, { waitUntil });
      emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title, waitUntil });
      return output;
    }

    if (action === 'locate') {
      const target = targetLocator(page, input);
      const locator = target.locator;
      const count = await locator.count();
      const limit = Math.min(count, 10);
      const matches = [];
      for (let i = 0; i < limit; i++) {
        const item = locator.nth(i);
        const text = await item.innerText({ timeout: actionTimeout }).catch(() => '');
        const tagName = await item.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
        matches.push({
          index: i,
          tagName,
          text: truncateText(text.replace(/\s+/g, ' ').trim(), 300).text,
        });
      }
      const output = await pageSnapshot(page, action, {
        selector: target.selector,
        textQuery: target.textQuery,
        count,
        matches,
        truncated: count > limit,
      });
      emitStep(emit, {
        phase: 'complete',
        action,
        url: output.url,
        title: output.title,
        selector: target.selector,
        textQuery: target.textQuery,
        count,
      });
      return output;
    }

    if (action === 'text') {
      const rawText = input.selector
        ? await page.locator(input.selector).first().innerText({ timeout: actionTimeout })
        : await page.locator('body').innerText({ timeout: actionTimeout });
      const result = truncateText(rawText, maxTextChars);
      const output = await pageSnapshot(page, action, {
        selector: input.selector || 'body',
        text: result.text,
        truncated: result.truncated,
      });
      emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title, selector: output.selector, textLength: result.text.length, truncated: result.truncated });
      return output;
    }

    if (action === 'screenshot') {
      const dir = screenshotDir(config);
      await mkdir(dir, { recursive: true });
      const filename = screenshotFilename(input.screenshotName);
      const path = join(dir, filename);
      await page.screenshot({ path, fullPage: input.fullPage === true, timeout: actionTimeout });
      const output = await pageSnapshot(page, action, {
        screenshotPath: path,
        screenshotUrl: screenshotUrlFromPath(path),
        fullPage: input.fullPage === true,
      });
      emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title, screenshotPath: path, screenshotUrl: output.screenshotUrl, fullPage: output.fullPage });
      return output;
    }

    if (action === 'evaluate') {
      const value = await evaluateScript(page, input.script);
      const preview = safeJsonPreview(value, maxTextChars);
      const output = await pageSnapshot(page, action, {
        result: preview.text,
        resultType: Array.isArray(value) ? 'array' : typeof value,
        truncated: preview.truncated,
      });
      emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title, resultType: output.resultType, truncated: output.truncated });
      return output;
    }

    const output = await pageSnapshot(page, action);
    emitStep(emit, { phase: 'complete', action, url: output.url, title: output.title });
    return output;
  },

  parseResult(output) {
    return {
      renderType: 'browser-action',
      data: {
        action: output.action,
        url: output.url,
        title: output.title,
        statusCode: output.statusCode,
        selector: output.selector,
        textQuery: output.textQuery,
        count: output.count,
        matches: output.matches,
        key: output.key,
        text: output.text,
        result: output.result,
        resultType: output.resultType,
        screenshotPath: output.screenshotPath,
        screenshotUrl: output.screenshotUrl || screenshotUrlFromPath(output.screenshotPath),
        fullPage: output.fullPage,
        truncated: output.truncated,
        closed: output.closed,
      },
    };
  },

  __test: {
    validateHttpUrl,
    assertAllowedUrl,
    screenshotFilename,
    truncateText,
    safeJsonPreview,
    screenshotUrlFromPath,
    targetLocator,
    closeSession,
  },
};
