import { mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getProjectRoot } from '../../workspace-root.mjs';
import { closeBrowserSession, ensureBrowserPage, publishBrowserState } from '../browser-cdp-session.mjs';

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
const DEFAULT_SCREENSHOT_SETTLE_MS = 250;
const DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS = 5000;
const SCREENSHOT_ROUTE_BASE = '/api/v1/tool-assets/browser-screenshots';

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

function screenshotSettleMs(config) {
  return clampInteger(
    config?.screenshotSettleMs,
    DEFAULT_SCREENSHOT_SETTLE_MS,
    0,
    5000,
  );
}

function screenshotLoadTimeoutMs(config, actionTimeout) {
  return Math.min(
    actionTimeout,
    clampInteger(
      config?.screenshotLoadTimeoutMs,
      DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS,
      0,
      30_000,
    ),
  );
}

function screenshotWaitUntil(input) {
  return input.waitUntil && input.waitUntil !== 'commit' ? input.waitUntil : 'load';
}

async function waitForScreenshotReady(page, input, config, actionTimeout) {
  const loadTimeout = screenshotLoadTimeoutMs(config, actionTimeout);
  if (loadTimeout > 0) {
    await page.waitForLoadState(screenshotWaitUntil(input), { timeout: loadTimeout }).catch(() => {});
    await page.waitForFunction(() => {
      const body = document.body;
      if (!body) return false;
      const rect = body.getBoundingClientRect();
      const hasBodyContent = String(body.innerText || '').trim().length > 0 || document.images.length > 0;
      return rect.width > 0 && rect.height > 0 && hasBodyContent;
    }, { timeout: loadTimeout }).catch(() => {});
  }

  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready.catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }).catch(() => {});

  const settleMs = screenshotSettleMs(config);
  if (settleMs > 0) await page.waitForTimeout(Math.min(settleMs, actionTimeout));
}

async function pageCaptureMetrics(page) {
  const viewport = page.viewportSize?.() || {};
  const metrics = await page.evaluate(() => {
    const body = document.body;
    const doc = document.documentElement;
    const widths = [
      window.innerWidth,
      doc?.clientWidth,
      doc?.scrollWidth,
      body?.clientWidth,
      body?.scrollWidth,
      body?.offsetWidth,
    ].filter(Number.isFinite);
    const heights = [
      window.innerHeight,
      doc?.clientHeight,
      doc?.scrollHeight,
      body?.clientHeight,
      body?.scrollHeight,
      body?.offsetHeight,
    ].filter(Number.isFinite);
    return {
      pageWidth: Math.ceil(Math.max(...widths, 1)),
      pageHeight: Math.ceil(Math.max(...heights, 1)),
      viewportWidth: Math.ceil(window.innerWidth || doc?.clientWidth || 1),
      viewportHeight: Math.ceil(window.innerHeight || doc?.clientHeight || 1),
    };
  }).catch(() => ({}));

  return {
    pageWidth: clampInteger(metrics.pageWidth, viewport.width || DEFAULT_VIEWPORT_WIDTH, 1, 100_000),
    pageHeight: clampInteger(metrics.pageHeight, viewport.height || DEFAULT_VIEWPORT_HEIGHT, 1, 1_000_000),
    viewportWidth: clampInteger(viewport.width || metrics.viewportWidth, DEFAULT_VIEWPORT_WIDTH, 1, 100_000),
    viewportHeight: clampInteger(viewport.height || metrics.viewportHeight, DEFAULT_VIEWPORT_HEIGHT, 1, 100_000),
  };
}

function screenshotCapturePlan(input, config, metrics) {
  const fullPageRequested = input.fullPage === true;
  const viewportWidth = Math.max(1, Number(metrics?.viewportWidth) || DEFAULT_VIEWPORT_WIDTH);
  const viewportHeight = Math.max(1, Number(metrics?.viewportHeight) || DEFAULT_VIEWPORT_HEIGHT);
  const pageHeight = Math.max(viewportHeight, Number(metrics?.pageHeight) || viewportHeight);
  const fullPageTruncated = fullPageRequested && pageHeight > viewportHeight;
  return {
    options: { fullPage: false },
    metadata: {
      fullPage: false,
      fullPageRequested,
      fullPageTruncated,
      pageHeight,
      screenshotWidth: viewportWidth,
      screenshotHeight: viewportHeight,
      truncated: fullPageTruncated,
    },
  };
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
    screenshotSettleMs: DEFAULT_SCREENSHOT_SETTLE_MS,
    screenshotLoadTimeoutMs: DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS,
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
      screenshotSettleMs: { type: 'number', description: 'Extra delay before screenshots after load and paint readiness checks.' },
      screenshotLoadTimeoutMs: { type: 'number', description: 'Maximum time to wait for page load before taking a screenshot.' },
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
        screenshotSettleMs: 250,
        screenshotLoadTimeoutMs: 5000,
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
        description: 'Navigation wait condition for action=open, or pre-screenshot load state for action=screenshot.',
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
        description: 'For action=screenshot, record that a full-page capture was requested. Actual screenshots are constrained to the current viewport box.',
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
      await closeBrowserSession();
      emitStep(emit, { phase: 'complete', action, closed: true });
      return { action, closed: true };
    }

    const page = await ensureBrowserPage(config);
    if (signal?.aborted) throw new Error('Browser action aborted');

    const completeAction = async (output, event = {}) => {
      emitStep(emit, {
        phase: 'complete',
        action,
        url: output.url,
        title: output.title,
        ...event,
      });
      await publishBrowserState({ status: 'streaming', action });
      return output;
    };

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
      return completeAction(output, { statusCode: output.statusCode });
    }

    if (action === 'click') {
      const target = targetLocator(page, input);
      await target.locator.first().click({ timeout: actionTimeout });
      const output = await pageSnapshot(page, action, { selector: target.selector, textQuery: target.textQuery });
      return completeAction(output, {
        selector: target.selector,
        textQuery: target.textQuery,
      });
    }

    if (action === 'type') {
      const locator = page.locator(input.selector).first();
      if (input.clear === false) {
        await locator.pressSequentially(input.text, { timeout: actionTimeout });
      } else {
        await locator.fill(input.text, { timeout: actionTimeout });
      }
      const output = await pageSnapshot(page, action, { selector: input.selector, textLength: input.text.length });
      return completeAction(output, { selector: input.selector, textLength: input.text.length });
    }

    if (action === 'press') {
      await page.keyboard.press(input.key);
      const output = await pageSnapshot(page, action, { key: input.key });
      return completeAction(output, { key: input.key });
    }

    if (action === 'wait_for') {
      if (input.selector) {
        await page.locator(input.selector).first().waitFor({
          state: input.waitState || 'visible',
          timeout: actionTimeout,
        });
        const output = await pageSnapshot(page, action, { selector: input.selector, waitState: input.waitState || 'visible' });
        return completeAction(output, { selector: input.selector, waitState: output.waitState });
      }
      const waitUntil = input.waitUntil || 'domcontentloaded';
      await page.waitForLoadState(waitUntil, { timeout: actionTimeout });
      const output = await pageSnapshot(page, action, { waitUntil });
      return completeAction(output, { waitUntil });
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
      return completeAction(output, {
        selector: target.selector,
        textQuery: target.textQuery,
        count,
      });
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
      return completeAction(output, { selector: output.selector, textLength: result.text.length, truncated: result.truncated });
    }

    if (action === 'screenshot') {
      const dir = screenshotDir(config);
      await mkdir(dir, { recursive: true });
      const filename = screenshotFilename(input.screenshotName);
      const path = join(dir, filename);
      await waitForScreenshotReady(page, input, config, actionTimeout);
      const metrics = await pageCaptureMetrics(page);
      const capture = screenshotCapturePlan(input, config, metrics);
      await page.screenshot({
        path,
        timeout: actionTimeout,
        animations: 'disabled',
        ...capture.options,
      });
      const output = await pageSnapshot(page, action, {
        screenshotPath: path,
        screenshotUrl: screenshotUrlFromPath(path),
        ...capture.metadata,
      });
      return completeAction(output, {
        screenshotPath: path,
        screenshotUrl: output.screenshotUrl,
        fullPage: output.fullPage,
        fullPageRequested: output.fullPageRequested,
        fullPageTruncated: output.fullPageTruncated,
        pageHeight: output.pageHeight,
        screenshotWidth: output.screenshotWidth,
        screenshotHeight: output.screenshotHeight,
        truncated: output.truncated,
      });
    }

    if (action === 'evaluate') {
      const value = await evaluateScript(page, input.script);
      const preview = safeJsonPreview(value, maxTextChars);
      const output = await pageSnapshot(page, action, {
        result: preview.text,
        resultType: Array.isArray(value) ? 'array' : typeof value,
        truncated: preview.truncated,
      });
      return completeAction(output, { resultType: output.resultType, truncated: output.truncated });
    }

    const output = await pageSnapshot(page, action);
    return completeAction(output);
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
        fullPageRequested: output.fullPageRequested,
        fullPageTruncated: output.fullPageTruncated,
        pageHeight: output.pageHeight,
        screenshotWidth: output.screenshotWidth,
        screenshotHeight: output.screenshotHeight,
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
    screenshotCapturePlan,
    targetLocator,
    closeSession: closeBrowserSession,
  },
};
