import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function fakeClassList() {
  const classes = new Set();
  return {
    add(value) {
      classes.add(value);
    },
    remove(value) {
      classes.delete(value);
    },
    toggle(value, force) {
      if (force === true) {
        classes.add(value);
        return true;
      }
      if (force === false) {
        classes.delete(value);
        return false;
      }
      if (classes.has(value)) {
        classes.delete(value);
        return false;
      }
      classes.add(value);
      return true;
    },
    contains(value) {
      return classes.has(value);
    },
  };
}

function fakeElement() {
  const attributes = new Map();
  return {
    style: {},
    classList: fakeClassList(),
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    type: '',
    checked: false,
    scrollTop: 0,
    scrollHeight: 0,
    addEventListener() {},
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    appendChild() {},
    contains(target) {
      return target === this;
    },
    closest() {
      return null;
    },
    focus() {},
    querySelector() {
      return fakeElement();
    },
    querySelectorAll() {
      return [];
    },
  };
}

globalThis.document = {
  addEventListener() {},
  createElement() {
    return fakeElement();
  },
  querySelector(selector) {
    if (selector === '#messages' && globalThis.__fakeMessages) return globalThis.__fakeMessages;
    return fakeElement();
  },
};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.window = { CSS: { escape: String } };
globalThis.CSS = { escape: String };
globalThis.marked = {
  parse(value) {
    return String(value || '').replace(/```mermaid\n([\s\S]*?)\n```/g, (_match, source) => (
      `<pre><code class="language-mermaid">${source}</code></pre>`
    ));
  },
  setOptions() {},
};
globalThis.katex = {
  renderToString(value) {
    return String(value || '');
  },
};
globalThis.mermaid = {
  initialize() {},
  render() {
    return Promise.resolve({ svg: '<svg data-test="svg-rendered"></svg>' });
  },
};

describe('frontend module boundaries', () => {
  it('keeps the views compatibility exports available', async () => {
    const views = await import('../public/js/views.js');
    const expectedExports = [
      'addAssistantPlaceholder',
      'addUserMessage',
      'collectChannelPricingOverrides',
      'effectivePricingForChannelModel',
      'hideChannelEditor',
      'hidePricingEditor',
      'hideSettings',
      'hideToolRunDetail',
      'hideUsageRunDetail',
      'hydrateAssistantMessages',
      'isVisibleMessage',
      'pricingPayloadFromEditor',
      'renderBasePricing',
      'renderChannelList',
      'renderConvoList',
      'renderMessages',
      'renderSelectors',
      'renderToolList',
      'renderToolRuns',
      'renderUsageReport',
      'scrollBottom',
      'showChannelEditor',
      'showChannelsPage',
      'showChatPage',
      'showPricingEditor',
      'showPricingPageFrame',
      'showSettings',
      'showToolRunDetail',
      'showToolsPageFrame',
      'showUsagePageFrame',
      'showUsageRunDetail',
    ];

    for (const name of expectedExports) {
      assert.equal(typeof views[name], 'function', `${name} should be exported as a function`);
    }
  });

  it('loads split controller modules without missing imports', async () => {
    const modules = await Promise.all([
      import('../public/js/controllers/channels-controller.js'),
      import('../public/js/controllers/chat-header-controller.js'),
      import('../public/js/controllers/chat-input-controller.js'),
      import('../public/js/controllers/conversations-controller.js'),
      import('../public/js/controllers/pricing-controller.js'),
      import('../public/js/controllers/settings-controller.js'),
      import('../public/js/controllers/tools-controller.js'),
      import('../public/js/controllers/usage-controller.js'),
    ]);

    assert.equal(typeof modules[0].bindChannelsController, 'function');
    assert.equal(typeof modules[0].loadActive, 'function');
    assert.equal(typeof modules[1].bindChatHeaderController, 'function');
    assert.equal(typeof modules[1].renderChatHeaderActions, 'function');
    assert.equal(typeof modules[2].bindChatInputController, 'function');
    assert.equal(typeof modules[3].bindConversationsController, 'function');
    assert.equal(typeof modules[3].loadConversations, 'function');
    assert.equal(typeof modules[3].selectConversation, 'function');
    assert.equal(typeof modules[4].bindPricingController, 'function');
    assert.equal(typeof modules[4].loadBasePricing, 'function');
    assert.equal(typeof modules[4].showPricingPage, 'function');
    assert.equal(typeof modules[5].bindSettingsController, 'function');
    assert.equal(typeof modules[6].bindToolsController, 'function');
    assert.equal(typeof modules[6].showToolsPage, 'function');
    assert.equal(typeof modules[7].bindUsageController, 'function');
    assert.equal(typeof modules[7].showUsagePage, 'function');
  });

  it('shows the Feishu token menu only when feishu_auth is enabled', async () => {
    const { state } = await import('../public/js/state.js');
    const { dom } = await import('../public/js/dom.js');
    const { renderChatHeaderActions } = await import('../public/js/controllers/chat-header-controller.js');

    state.tools = [{ id: 'feishu_auth', enabled: false, config: {} }];
    renderChatHeaderActions();
    assert.equal(dom.feishuTokenMenuWrap.classList.contains('hidden'), true);

    state.tools = [{ id: 'feishu_auth', enabled: true, config: { user_access_token: 'u-token' } }];
    renderChatHeaderActions();
    assert.equal(dom.feishuTokenMenuWrap.classList.contains('hidden'), false);
    assert.equal(dom.btnFeishuTokenMenu.getAttribute('aria-label'), 'Feishu token actions');
  });

  it('clears Feishu token through dedicated endpoint without sending config overwrite', async () => {
    const { state } = await import('../public/js/state.js');
    const { dom } = await import('../public/js/dom.js');
    const { bindChatHeaderController } = await import('../public/js/controllers/chat-header-controller.js');
    const listeners = {};
    dom.btnFeishuTokenMenu.addEventListener = (event, handler) => {
      listeners[`menu:${event}`] = handler;
    };
    dom.btnClearFeishuToken.addEventListener = (event, handler) => {
      listeners[`clear:${event}`] = handler;
    };

    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      assert.equal(String(url), '/api/v1/tools/feishu_auth/clear-token');
      assert.equal(options.method, 'POST');
      assert.equal(options.body, undefined);
      return {
        ok: true,
        async json() {
          return {
            feishu_auth: {
              id: 'feishu_auth',
              enabled: true,
              config: { app_id: 'cli_xxx', app_secret: 'secret', user_access_token: '' },
            },
            feishu_read: {
              id: 'feishu_read',
              enabled: true,
              config: { user_access_token: '' },
            },
          };
        },
      };
    };

    try {
      state.tools = [
        { id: 'feishu_auth', enabled: true, config: { user_access_token: 'u-token' } },
        { id: 'feishu_read', enabled: true, config: { user_access_token: 'read-token' } },
      ];
      bindChatHeaderController();
      dom.feishuTokenMenu.classList.add('hidden');
      listeners['menu:click']({ stopPropagation() {} });
      assert.equal(dom.feishuTokenMenu.classList.contains('hidden'), false);
      await listeners['clear:click']();
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1);
    assert.equal(state.tools.find(tool => tool.id === 'feishu_auth').config.app_id, 'cli_xxx');
    assert.equal(state.tools.find(tool => tool.id === 'feishu_auth').config.app_secret, 'secret');
    assert.equal(state.tools.find(tool => tool.id === 'feishu_auth').config.user_access_token, '');
  });

  it('shows shell command blocks while the command is still running', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    let scheduled = 0;
    const stream = {
      conversationId: 'conv1',
      blocks: [],
      renderer: {
        schedule() {
          scheduled++;
        },
        flush() {
          scheduled++;
        },
        cancel() {},
      },
    };

    appendStreamEvent({
      type: 'tool_call',
      seq: 1,
      tools: [{
        id: 'toolu_shell_1',
        name: 'shell_command',
        input: { command: 'npm test', cwd: '.' },
      }],
    }, stream);

    assert.equal(stream.blocks.length, 1);
    assert.equal(stream.blocks[0].type, 'shell-command');
    assert.equal(stream.blocks[0].toolCallId, 'toolu_shell_1');
    assert.equal(stream.blocks[0].status, 'running');
    assert.equal(stream.blocks[0].command, 'npm test');
    assert.equal(stream.blocks[0].collapsed, false);

    appendStreamEvent({
      type: 'tool_result',
      seq: 2,
      tools: [{
        id: 'toolu_shell_1',
        name: 'shell_command',
        isError: false,
        renderType: 'shell-command',
        data: {
          command: 'npm test',
          cwd: 'D:\\Project\\AI\\xwork',
          exitCode: 0,
          durationMs: 1200,
          stdout: 'ok',
          stderr: '',
          truncated: false,
        },
      }],
    }, stream);

    assert.equal(stream.blocks.length, 2);
    assert.equal(stream.blocks[0].status, 'completed');
    assert.equal(stream.blocks[0].collapsed, true);
    assert.equal(stream.blocks[0].exitCode, 0);
    assert.equal(stream.blocks[0].stdout, 'ok');
    assert.equal(stream.blocks[1].type, 'text');
    assert.ok(scheduled >= 2);
  });

  it('marks a running shell command as errored when safety validation blocks it', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const stream = {
      conversationId: 'conv1',
      blocks: [],
      renderer: {
        schedule() {},
        flush() {},
        cancel() {},
      },
    };

    appendStreamEvent({
      type: 'tool_call',
      seq: 1,
      tools: [{
        id: 'toolu_shell_blocked',
        name: 'shell_command',
        input: { command: 'rm -rf ~/Library/Caches/*' },
      }],
    }, stream);

    appendStreamEvent({
      type: 'tool_result',
      seq: 2,
      tools: [{
        id: 'toolu_shell_blocked',
        name: 'shell_command',
        isError: true,
        durationMs: 2,
        output: 'command blocked by shell safety policy',
      }],
    }, stream);

    assert.equal(stream.blocks[0].type, 'shell-command');
    assert.equal(stream.blocks[0].status, 'error');
    assert.equal(stream.blocks[0].collapsed, true);
    assert.match(stream.blocks[1].content, /Tool error: shell_command/);
  });

  it('appends shell command output while the command is running', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    let scheduled = 0;
    const stream = {
      conversationId: 'conv1',
      blocks: [],
      renderer: {
        schedule() {
          scheduled++;
        },
        flush() {
          scheduled++;
        },
        cancel() {},
      },
    };

    appendStreamEvent({
      type: 'tool_call',
      seq: 1,
      tools: [{
        id: 'toolu_shell_stream',
        name: 'shell_command',
        input: { command: 'npm install' },
      }],
    }, stream);
    appendStreamEvent({
      type: 'tool_delta',
      seq: 2,
      id: 'toolu_shell_stream',
      name: 'shell_command',
      stream: 'stdout',
      text: 'fetching packages\n',
    }, stream);
    appendStreamEvent({
      type: 'tool_delta',
      seq: 3,
      id: 'toolu_shell_stream',
      name: 'shell_command',
      stream: 'stderr',
      text: 'warning\n',
    }, stream);

    assert.equal(stream.blocks[0].stdout, 'fetching packages\n');
    assert.equal(stream.blocks[0].stderr, 'warning\n');
    assert.equal(stream.blocks[0].status, 'running');
    assert.equal(stream.blocks[0].collapsed, false);
    assert.ok(scheduled >= 3);
  });

  it('lets stream reducer use injected effects instead of global UI state', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    let hidden = 0;
    let scheduled = 0;
    const stream = {
      conversationId: 'conv1',
      blocks: [{ type: 'text', content: '' }],
      renderer: {
        schedule() {
          scheduled++;
        },
        flush() {},
        cancel() {},
      },
    };

    appendStreamEvent({
      type: 'delta',
      seq: 1,
      text: 'hello',
    }, stream, {
      isActiveConversation: () => true,
      showThinking() {},
      hideThinking() {
        hidden++;
      },
      scheduleRender() {
        scheduled++;
      },
      flushRender() {},
      cancelRender() {},
    });

    assert.equal(stream.blocks[0].content, 'hello');
    assert.equal(hidden, 1);
    assert.equal(scheduled, 1);
  });

  it('can defer Mermaid rendering until a message is ready', async () => {
    const { renderPendingMermaid } = await import('../public/js/renderers.js');
    const target = { id: 'mermaid-test', innerHTML: '' };
    const source = { textContent: 'flowchart TD\n  A --> B' };
    const block = {
      dataset: {},
      querySelector(selector) {
        if (selector === '.mermaid-render') return target;
        if (selector === '.mermaid-source code') return source;
        return null;
      },
    };
    const root = {
      querySelectorAll(selector) {
        return selector === '.mermaid-block' ? [block] : [];
      },
    };

    renderPendingMermaid(root, { defer: true });
    assert.equal(target.innerHTML, '');

    renderPendingMermaid(root);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(target.innerHTML, /svg-rendered/);
  });

  it('renders shell command output with terminal-like structure', async () => {
    const { renderBlocks } = await import('../public/js/renderers.js');
    const html = renderBlocks([{
      type: 'shell-command',
      status: 'completed',
      command: 'npm test',
      cwd: 'D:\\Project\\AI\\xwork',
      exitCode: 1,
      stdout: 'stdout line',
      stderr: 'stderr line',
      durationMs: 123,
    }], false);

    assert.match(html, /shell-terminal/);
    assert.match(html, /shell-terminal-prompt/);
    assert.match(html, /shell-terminal-output stdout/);
    assert.match(html, /shell-terminal-output stderr/);
    assert.match(html, /npm test/);
  });

  it('renders browser action results as a collapsible block', async () => {
    const { renderBlocks } = await import('../public/js/renderers.js');
    const html = renderBlocks([{
      type: 'browser-action',
      action: 'screenshot',
      url: 'http://localhost:3000/',
      title: 'xwork',
      statusCode: 200,
      screenshotPath: '/workspace/data/browser-screenshots/home.png',
      screenshotUrl: '/api/v1/tool-assets/browser-screenshots/home.png',
      textQuery: '仙童数学',
      steps: [
        { phase: 'start', action: 'screenshot', label: 'start screenshot' },
        { phase: 'complete', action: 'screenshot', label: 'complete screenshot', screenshotPath: '/workspace/data/browser-screenshots/home.png', textQuery: '仙童数学' },
      ],
      text: 'visible page text',
      collapsed: true,
    }], false);

    assert.match(html, /browser-action-toggle collapsed/);
    assert.match(html, /xwork/);
    assert.match(html, /HTTP 200/);
    assert.match(html, /browser-screenshots\/home\.png/);
    assert.match(html, /<img src="\/api\/v1\/tool-assets\/browser-screenshots\/home\.png"/);
    assert.match(html, /browser-action-steps/);
    assert.match(html, /complete screenshot/);
    assert.match(html, /仙童数学/);
    assert.match(html, /visible page text/);
  });

  it('streams browser action steps and merges final tool result into the same block', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const stream = {
      conversationId: 'test',
      blocks: [],
      renderer: { schedule() {}, flush() {}, cancel() {} },
    };
    let scheduled = 0;

    const effects = {
      isActiveConversation: () => true,
      showThinking() {},
      hideThinking() {},
      scheduleRender() {
        scheduled++;
      },
      flushRender() {},
      cancelRender() {},
    };

    appendStreamEvent({
      type: 'tool_call',
      tools: [{
        id: 'toolu_browser',
        name: 'browser_action',
        input: { action: 'screenshot', url: 'http://localhost:3000/' },
      }],
    }, stream, effects);

    appendStreamEvent({
      type: 'tool_delta',
      id: 'toolu_browser',
      name: 'browser_action',
      stream: 'browser',
      phase: 'start',
      action: 'screenshot',
      url: 'http://localhost:3000/',
      ts: '2026-05-22T00:00:00.000Z',
    }, stream, effects);

    appendStreamEvent({
      type: 'tool_delta',
      id: 'toolu_browser',
      name: 'browser_action',
      stream: 'browser',
      phase: 'complete',
      action: 'screenshot',
      url: 'http://localhost:3000/',
      title: 'xwork',
      screenshotUrl: '/api/v1/tool-assets/browser-screenshots/home.png',
      textQuery: 'Run',
      ts: '2026-05-22T00:00:01.000Z',
    }, stream, effects);

    appendStreamEvent({
      type: 'tool_result',
      tools: [{
        id: 'toolu_browser',
        name: 'browser_action',
        isError: false,
        renderType: 'browser-action',
        data: {
          action: 'screenshot',
          url: 'http://localhost:3000/',
          title: 'xwork',
          screenshotUrl: '/api/v1/tool-assets/browser-screenshots/home.png',
          textQuery: 'Run',
        },
      }],
    }, stream, effects);

    assert.equal(stream.blocks[0].type, 'browser-action');
    assert.equal(stream.blocks.length, 2);
    assert.equal(stream.blocks[0].collapsed, true);
    assert.equal(stream.blocks[0].toolCallId, 'toolu_browser');
    assert.equal(stream.blocks[0].status, 'completed');
    assert.equal(stream.blocks[0].steps.length, 3);
    assert.equal(stream.blocks[0].screenshotUrl, '/api/v1/tool-assets/browser-screenshots/home.png');
    assert.equal(stream.blocks[0].textQuery, 'Run');
    assert.equal(scheduled, 3);
  });

  it('expands while running and collapses after grep completes', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    let flushed = 0;
    const stream = {
      conversationId: 'conv1',
      blocks: [{ type: 'text', content: '' }],
      renderer: {
        schedule() {},
        flush() {
          flushed++;
        },
        cancel() {},
      },
    };

    appendStreamEvent({
      type: 'tool_call',
      seq: 1,
      tools: [{
        id: 'toolu_grep_1',
        name: 'grep',
        input: { pattern: 'xwork', glob: 'package.json' },
      }],
    }, stream);

    assert.equal(stream.blocks[1].type, 'tool-running');
    assert.equal(stream.blocks[1].status, 'running');
    assert.equal(stream.blocks[1].collapsed, false);

    appendStreamEvent({
      type: 'tool_result',
      seq: 2,
      tools: [{
        id: 'toolu_grep_1',
        name: 'grep',
        isError: false,
        renderType: 'grep-matches',
        data: {
          pattern: 'xwork',
          matches: [{ path: 'package.json', line: 2, content: '"name": "xwork"' }],
          matchCount: 1,
        },
      }],
    }, stream);

    assert.equal(stream.blocks[1].type, 'grep-matches');
    assert.equal(stream.blocks[1].status, 'completed');
    assert.equal(stream.blocks[1].collapsed, true);
    assert.equal(flushed, 1);
  });

  it('marks generic current-time tool blocks completed after result', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const { renderBlocks } = await import('../public/js/renderers.js');
    const stream = {
      conversationId: 'conv1',
      blocks: [{ type: 'text', content: '' }],
      renderer: {
        schedule() {},
        flush() {},
        cancel() {},
      },
    };

    appendStreamEvent({
      type: 'tool_call',
      seq: 1,
      tools: [{
        id: 'toolu_time_1',
        name: 'get_current_time',
        input: { timezone: 'Asia/Shanghai' },
      }],
    }, stream);

    assert.equal(stream.blocks[1].type, 'tool-running');
    assert.equal(stream.blocks[1].status, 'running');

    appendStreamEvent({
      type: 'tool_result',
      seq: 2,
      tools: [{
        id: 'toolu_time_1',
        name: 'get_current_time',
        isError: false,
        durationMs: 2,
        input: { timezone: 'Asia/Shanghai' },
      }],
    }, stream);

    assert.equal(stream.blocks[1].type, 'tool-running');
    assert.equal(stream.blocks[1].status, 'completed');
    assert.equal(stream.blocks[1].collapsed, true);

    const html = renderBlocks([stream.blocks[1]], true);
    assert.match(html, /completed/);
    assert.doesNotMatch(html, /status-running">running/);
  });

  it('collapses browser tool blocks after errors', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const stream = {
      conversationId: 'conv1',
      blocks: [],
      renderer: { schedule() {}, flush() {}, cancel() {} },
    };

    appendStreamEvent({
      type: 'tool_call',
      tools: [{
        id: 'toolu_browser_err',
        name: 'browser_action',
        input: { action: 'open', url: 'http://localhost:3000/' },
      }],
    }, stream);

    appendStreamEvent({
      type: 'tool_result',
      tools: [{
        id: 'toolu_browser_err',
        name: 'browser_action',
        isError: true,
        output: 'blocked by policy',
      }],
    }, stream);

    assert.equal(stream.blocks[0].status, 'error');
    assert.equal(stream.blocks[0].collapsed, true);
  });

});
