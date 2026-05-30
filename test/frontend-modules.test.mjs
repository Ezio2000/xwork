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
  const listeners = new Map();
  const children = new Map();
  const addListener = (event, handler) => {
    const handlers = listeners.get(event) || [];
    handlers.push(handler);
    listeners.set(event, handlers);
  };
  return {
    __listeners: listeners,
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
    clientHeight: 0,
    hidden: false,
    complete: true,
    isConnected: true,
    tabIndex: 0,
    addEventListener(event, handler) {
      addListener(event, handler);
    },
    dispatchEvent(event) {
      const type = event?.type || event;
      for (const handler of listeners.get(type) || []) handler(event);
    },
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
    scrollTo(options) {
      this.scrollTop = typeof options === 'number' ? options : options?.top ?? this.scrollTop;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 460, height: 259, right: 460, bottom: 259 };
    },
    setPointerCapture() {},
    getContext() {
      return { clearRect() {}, drawImage() {} };
    },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, fakeElement());
      return children.get(selector);
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
    if (selector === '#browser-live-preview' && globalThis.__fakeBrowserLivePreview) return globalThis.__fakeBrowserLivePreview;
    return fakeElement();
  },
};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.window = { CSS: { escape: String } };
globalThis.CSS = { escape: String };
globalThis.Image = class {
  constructor() {
    this.naturalWidth = 1;
    this.naturalHeight = 1;
    this.width = 1;
    this.height = 1;
    this.onload = null;
  }
  set src(_value) {
    this.onload?.();
  }
};
globalThis.marked = {
  Renderer: class {},
  parse(value, options = {}) {
    let html = String(value || '').replace(/```mermaid\n([\s\S]*?)\n```/g, (_match, source) => (
      `<pre><code class="language-mermaid">${source}</code></pre>`
    ));
    if (options?.renderer?.html) {
      html = html.replace(/<!doctype\s+html[\s\S]*$/i, match => options.renderer.html({
        type: 'html',
        raw: match,
        text: match,
      }));
      html = html.replace(/<script[\s\S]*$/i, match => options.renderer.html({
        type: 'html',
        raw: match,
        text: match,
      }));
    }
    return html;
  },
  setOptions() {},
};
globalThis.katex = {
  renderToString(value) {
    return String(value || '');
  },
};
globalThis.mermaid = {
  initialize(options) {
    globalThis.__lastMermaidInitializeOptions = options;
  },
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
      'hideExpertAgentEditor',
      'hidePricingEditor',
      'hideSettings',
      'hideToolRunDetail',
      'hideUsageRunDetail',
      'hideVisionProviderEditor',
      'hydrateAssistantMessages',
      'isVisibleMessage',
      'maintainAutoScrollAnchor',
      'pricingPayloadFromEditor',
      'renderExpertAgentList',
      'renderBasePricing',
      'renderChannelList',
      'renderConvoList',
      'renderMessages',
      'renderSelectors',
      'renderToolList',
      'renderToolRuns',
      'renderUsageReport',
      'renderVisionProviderList',
      'scrollBottom',
      'showChannelEditor',
      'showChannelsPage',
      'showChatPage',
      'showExpertAgentEditor',
      'showExpertAgentsPageFrame',
      'showPricingEditor',
      'showPricingPageFrame',
      'showSettings',
      'showToolRunDetail',
      'showToolsPageFrame',
      'showUsagePageFrame',
      'showUsageRunDetail',
      'showVisionProviderEditor',
    ];

    for (const name of expectedExports) {
      assert.equal(typeof views[name], 'function', `${name} should be exported as a function`);
    }
  });

  it('keeps bottom follow enabled when streaming content grows without user scroll intent', async () => {
    const { dom } = await import('../public/js/dom.js');
    const { resetAutoScroll, scrollBottom } = await import('../public/js/conversation-view.js');

    resetAutoScroll();
    dom.messages.clientHeight = 400;
    dom.messages.scrollHeight = 1000;
    dom.messages.scrollTop = 300;
    dom.messages.dispatchEvent({ type: 'scroll' });

    scrollBottom();

    assert.equal(dom.messages.scrollTop, 1000);
  });

  it('keeps following the bottom after a streaming image loads', async () => {
    const { dom } = await import('../public/js/dom.js');
    const { maintainAutoScrollAnchor, resetAutoScroll } = await import('../public/js/conversation-view.js');
    const img = fakeElement();
    const root = {
      querySelectorAll(selector) {
        return selector === 'img' ? [img] : [];
      },
    };

    resetAutoScroll();
    img.complete = false;
    dom.messages.scrollHeight = 600;
    dom.messages.scrollTop = 600;

    maintainAutoScrollAnchor(root);
    dom.messages.scrollHeight = 900;
    img.dispatchEvent({ type: 'load' });

    assert.equal(dom.messages.scrollTop, 900);
  });

  it('loads split controller modules without missing imports', async () => {
    const modules = await Promise.all([
      import('../public/js/controllers/channels-controller.js'),
      import('../public/js/controllers/chat-header-controller.js'),
      import('../public/js/controllers/chat-input-controller.js'),
      import('../public/js/controllers/conversations-controller.js'),
      import('../public/js/controllers/expert-agents-controller.js'),
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
    assert.equal(typeof modules[4].bindExpertAgentsController, 'function');
    assert.equal(typeof modules[4].loadExpertAgents, 'function');
    assert.equal(typeof modules[4].showExpertAgentsPage, 'function');
    assert.equal(typeof modules[5].bindPricingController, 'function');
    assert.equal(typeof modules[5].loadBasePricing, 'function');
    assert.equal(typeof modules[5].showPricingPage, 'function');
    assert.equal(typeof modules[6].bindSettingsController, 'function');
    assert.equal(typeof modules[7].bindToolsController, 'function');
    assert.equal(typeof modules[7].showToolsPage, 'function');
    assert.equal(typeof modules[8].bindUsageController, 'function');
    assert.equal(typeof modules[8].showUsagePage, 'function');
  });

  it('detects missing sensitive setup values without exposing secret contents', async () => {
    const { state } = await import('../public/js/state.js');
    const { sensitiveSetupItems } = await import('../public/js/sensitive-setup-guide.js');

    state.activeChannelId = 'ch1';
    state.channels = [{ id: 'ch1', name: 'DeepSeek', apiKey: '' }];
    state.visionProviders = [{
      id: 'minimax',
      name: 'MiniMax',
      adapter: 'http_json',
      enabled: true,
      config: { auth: { type: 'bearer', apiKey: '' } },
    }];
    state.tools = [{
      id: 'feishu_auth',
      enabled: true,
      config: { app_id: 'cli_xxx', app_secret: '' },
    }];

    const items = sensitiveSetupItems();

    assert.deepEqual(items.map(item => item.id), ['chat-api-key', 'vision-api-key', 'feishu-app-secret']);
    assert.deepEqual(items.map(item => item.status), ['missing', 'missing', 'missing']);
    assert.doesNotMatch(JSON.stringify(items), /cli_xxx|sk-/);
  });

  it('shows the first use guide only when the user opens it', async () => {
    const { state } = await import('../public/js/state.js');
    const { dom } = await import('../public/js/dom.js');
    const {
      hideSensitiveSetupGuide,
      showSensitiveSetupGuide,
    } = await import('../public/js/sensitive-setup-guide.js');

    state.activeChannelId = 'ch1';
    state.channels = [{ id: 'ch1', name: 'DeepSeek', apiKey: '' }];
    state.visionProviders = [];
    state.tools = [];

    dom.sensitiveSetupModal.classList.add('hidden');
    assert.equal(dom.sensitiveSetupModal.classList.contains('hidden'), true);

    showSensitiveSetupGuide();
    assert.equal(dom.sensitiveSetupModal.classList.contains('hidden'), false);
    assert.match(dom.sensitiveSetupStatus.innerHTML, /Chat API key/);

    hideSensitiveSetupGuide();
    assert.equal(dom.sensitiveSetupModal.classList.contains('hidden'), true);
  });

  it('only offers main-agent enabled tools in the expert editor', async () => {
    const { state } = await import('../public/js/state.js');
    const { dom } = await import('../public/js/dom.js');
    const { showExpertAgentEditor } = await import('../public/js/expert-agent-view.js');

    state.channels = [];
    state.tools = [
      { id: 'web_search', name: 'web_search', title: 'Web Search', category: 'web', enabled: true },
      { id: 'shell_command', name: 'shell_command', title: 'Shell Command', category: 'system', enabled: false },
      { id: 'missing_tool', name: 'missing_tool', title: 'Missing Tool', category: 'unavailable', enabled: true, adapter: 'unavailable' },
    ];

    showExpertAgentEditor({
      id: 'agent_ui_policy',
      title: 'UI Policy Expert',
      enabled: true,
      systemPrompt: 'Check UI policy.',
      allowedTools: ['web_search', 'shell_command', 'missing_tool'],
    });

    assert.match(dom.editExpertAgentTools.innerHTML, /Web Search/);
    assert.doesNotMatch(dom.editExpertAgentTools.innerHTML, /Shell Command/);
    assert.doesNotMatch(dom.editExpertAgentTools.innerHTML, /Missing Tool/);
    assert.doesNotMatch(dom.editExpertAgentTools.innerHTML, /disabled globally/);
  });

  it('keeps the selected vision provider while repopulating fallback options', async () => {
    const { state } = await import('../public/js/state.js');
    const { dom } = await import('../public/js/dom.js');
    const { renderVisionConfig } = await import('../public/js/channel-view.js');

    state.visionProviders = [
      { id: 'minimax-token-plan-vlm', name: 'MiniMax Token Plan VLM', adapter: 'http_json' },
      { id: 'anthropic-vision', name: 'Anthropic Vision', adapter: 'anthropic_model' },
    ];
    state.vision = {
      defaultProviderId: 'minimax-token-plan-vlm',
      defaultFailureAction: 'reject',
    };

    renderVisionConfig();
    assert.equal(dom.visionProviderSelect.value, 'minimax-token-plan-vlm');
    assert.match(dom.visionProviderSelect.innerHTML, /MiniMax Token Plan VLM/);
    assert.match(dom.visionProviderList.innerHTML, /HTTP JSON/);

    dom.visionProviderSelect.value = 'anthropic-vision';
    renderVisionConfig({ preserveSelection: true });

    assert.equal(dom.visionProviderSelect.value, 'anthropic-vision');
    assert.match(dom.visionProviderSelect.innerHTML, /Anthropic Vision/);
  });

  it('renders the generic vision provider editor from provider config', async () => {
    const { dom } = await import('../public/js/dom.js');
    const { showVisionProviderEditor, hideVisionProviderEditor } = await import('../public/js/channel-view.js');

    showVisionProviderEditor({
      id: 'custom-http',
      name: 'Custom HTTP',
      adapter: 'http_json',
      config: {
        url: 'https://vision.example.test/parse',
        method: 'POST',
        timeoutMs: 120000,
        auth: { type: 'bearer', apiKey: 'sk-plain-test' },
        request: { bodyTemplate: {}, promptPath: 'prompt', imagePath: 'image', imageFormat: 'data_url' },
        response: { textPath: 'result.text' },
      },
    });

    assert.equal(dom.editVisionProviderId.value, 'custom-http');
    assert.equal(dom.editVisionProviderAdapter.value, 'http_json');
    assert.match(dom.editVisionProviderConfig.value, /vision\.example\.test/);
    assert.match(dom.editVisionProviderConfig.value, /sk-plain-test/);
    assert.equal(dom.visionProviderEditor.classList.contains('hidden'), false);

    hideVisionProviderEditor();
    assert.equal(dom.visionProviderEditor.classList.contains('hidden'), true);
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

  it('clears narrated assistant text when the backend retries missing tool calls', async () => {
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
    const effects = {
      isActiveConversation: () => true,
      showThinking() {},
      hideThinking() {},
      scheduleRender() {},
      flushRender() {
        flushed++;
      },
      cancelRender() {},
    };

    appendStreamEvent({ type: 'delta', seq: 1, text: '好的，我来点击并截图。' }, stream, effects);
    appendStreamEvent({
      type: 'assistant_retry',
      seq: 2,
      reason: 'tool_call_missing',
      message: 'retrying',
    }, stream, effects);

    assert.equal(stream.blocks.length, 1);
    assert.equal(stream.blocks[0].type, 'text');
    assert.equal(stream.blocks[0].content, '');
    assert.equal(stream.retryReason, 'tool_call_missing');
    assert.equal(stream.retryMessage, 'retrying');
    assert.equal(flushed, 1);
  });

  it('can defer Mermaid rendering until a message is ready', async () => {
    const { renderPendingMermaid } = await import('../public/js/renderers.js');
    const pendingTarget = { id: 'mermaid-pending', innerHTML: '' };
    const readyTarget = { id: 'mermaid-ready', innerHTML: '' };
    const source = { textContent: 'flowchart TD\n  A --> B' };
    const pendingBlock = {
      dataset: { pending: 'true' },
      querySelector(selector) {
        if (selector === '.mermaid-render') return pendingTarget;
        if (selector === '.mermaid-source code') return source;
        return null;
      },
    };
    const readyBlock = {
      dataset: {},
      querySelector(selector) {
        if (selector === '.mermaid-render') return readyTarget;
        if (selector === '.mermaid-source code') return source;
        return null;
      },
    };
    const root = {
      querySelectorAll(selector) {
        return selector === '.mermaid-block' ? [pendingBlock, readyBlock] : [];
      },
    };

    renderPendingMermaid(root, { defer: true });
    assert.equal(pendingTarget.innerHTML, '');
    assert.equal(readyTarget.innerHTML, '');

    renderPendingMermaid(root, { closedOnly: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(globalThis.__lastMermaidInitializeOptions?.htmlLabels, false);
    assert.equal(globalThis.__lastMermaidInitializeOptions?.flowchart?.htmlLabels, false);
    assert.equal(globalThis.__lastMermaidInitializeOptions?.flowchart?.useMaxWidth, true);
    assert.equal(pendingTarget.innerHTML, '');
    assert.match(readyTarget.innerHTML, /svg-rendered/);

    pendingBlock.dataset.pending = 'false';
    renderPendingMermaid(root);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(pendingTarget.innerHTML, /svg-rendered/);
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
      fullPageRequested: true,
      fullPageTruncated: true,
      pageHeight: 85588,
      screenshotWidth: 1365,
      screenshotHeight: 768,
      truncated: true,
      textQuery: '仙童数学',
      steps: [
        { phase: 'start', action: 'screenshot', label: 'start screenshot' },
        { phase: 'complete', action: 'screenshot', label: 'complete screenshot', screenshotPath: '/workspace/data/browser-screenshots/home.png', textQuery: '仙童数学', fullPageTruncated: true, screenshotWidth: 1365, screenshotHeight: 768 },
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
    assert.match(html, /1365x768px/);
    assert.match(html, /viewport only/);
    assert.match(html, /仙童数学/);
    assert.match(html, /visible page text/);
  });

  it('escapes raw HTML in web fetch previews so later blocks remain visible', async () => {
    const { renderBlocks } = await import('../public/js/renderers.js');
    const html = renderBlocks([
      {
        type: 'web-fetch',
        url: 'https://example.test/raw-html',
        statusCode: 200,
        contentType: 'application/json',
        contentLength: 2000,
        contentPreview: '<!DOCTYPE html>\n<html>\n<head>\n<script src="/asset.js"',
        collapsed: true,
      },
      { type: 'text', content: 'FINAL_VISIBLE' },
    ], true);

    assert.doesNotMatch(html, /<!DOCTYPE html>/i);
    assert.doesNotMatch(html, /<script\b/i);
    assert.match(html, /&lt;!DOCTYPE html&gt;/i);
    assert.match(html, /FINAL_VISIBLE/);
  });

  it('streams browser action steps and merges final tool result into the same block', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const { __test: browserPreviewTest } = await import('../public/js/browser-live-preview.js');
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
    assert.equal(browserPreviewTest.previewState.url, 'http://localhost:3000/');
    assert.equal(browserPreviewTest.previewState.status, 'streaming');
    assert.equal(scheduled, 3);
  });

  it('hides the live browser preview when a chat stream completes normally', async () => {
    const { state } = await import('../public/js/state.js');
    const { __test: chatStreamTest } = await import('../public/js/chat-stream.js');
    const { updateBrowserLivePreview, __test: browserPreviewTest } = await import('../public/js/browser-live-preview.js');

    globalThis.__fakeBrowserLivePreview = fakeElement();
    state.activeId = 'conv-browser-close';
    state.messages = [];
    state.conversations = [{ id: 'conv-browser-close', title: 'New Chat' }];
    state.streamingByConversationId = new Map([[
      'conv-browser-close',
      {
        conversationId: 'conv-browser-close',
        runId: 'run-browser-close',
        message: 'open page',
        images: [],
        originalMessageCount: 0,
        model: 'test-model',
        blocks: [{ type: 'text', content: 'done' }],
        renderer: { flush() {}, schedule() {}, cancel() {} },
      },
    ]]);

    updateBrowserLivePreview({
      id: 'toolu_browser_close',
      name: 'browser_action',
      action: 'open',
      status: 'streaming',
      url: 'http://localhost:3000/',
    }, { conversationId: 'conv-browser-close' });
    assert.equal(browserPreviewTest.previewState.visible, true);

    const stream = state.streamingByConversationId.get('conv-browser-close');
    chatStreamTest.finalizeStreamingMessage(stream);

    assert.equal(browserPreviewTest.previewState.visible, false);
    assert.equal(browserPreviewTest.previewState.toolCallId, '');
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

  it('shows subagent thinking state and nested tool blocks while running', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const { renderBlocks } = await import('../public/js/renderers.js');
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
      type: 'agent_event',
      seq: 1,
      eventType: 'subagent_start',
      runId: 'sub_run_1',
      status: 'running',
      label: 'Lookup',
      task: 'Search current event',
      expertAgent: { id: 'researcher', title: 'Research Expert' },
    }, stream);

    appendStreamEvent({
      type: 'agent_event',
      seq: 2,
      eventType: 'subagent_thinking',
      runId: 'sub_run_1',
      text: 'Planning search',
    }, stream);

    assert.equal(stream.blocks[0].thinking, true);
    let html = renderBlocks(stream.blocks, false);
    assert.match(html, /Research Expert/);
    assert.match(html, /thinking\.\.\./);

    appendStreamEvent({
      type: 'agent_event',
      seq: 3,
      eventType: 'subagent_tool_call',
      runId: 'sub_run_1',
      toolCallId: 'toolu_search_1',
      name: 'web_search',
      input: { query: 'Jensen Huang May 2026' },
    }, stream);

    assert.equal(stream.blocks[0].thinking, false);
    assert.equal(stream.blocks[0].blocks.at(-1).type, 'tool-running');
    assert.equal(stream.blocks[0].blocks.at(-1).toolCallId, 'toolu_search_1');
    assert.match(stream.blocks[0].blocks.at(-1).label, /Jensen Huang/);

    appendStreamEvent({
      type: 'agent_event',
      seq: 4,
      eventType: 'subagent_tool_result',
      runId: 'sub_run_1',
      toolCallId: 'toolu_search_1',
      name: 'web_search',
      isError: false,
      renderType: 'source-cards',
      data: { sources: [{ title: 'Result', url: 'https://example.test' }], searchCount: 1 },
    }, stream);

    const nested = stream.blocks[0].blocks.at(-1);
    assert.equal(nested.type, 'source-cards');
    assert.equal(nested.status, 'completed');
    assert.equal(nested.toolCallId, 'toolu_search_1');
    assert.equal(nested.collapsed, true);
  });

  it('keeps a subagent running after a nested tool error', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const { renderBlocks } = await import('../public/js/renderers.js');
    const stream = {
      conversationId: 'conv1',
      blocks: [],
      renderer: { schedule() {}, flush() {}, cancel() {} },
    };

    appendStreamEvent({
      type: 'agent_event',
      eventType: 'subagent_start',
      runId: 'sub_run_error_recovery',
      task: 'Try one flaky lookup',
      expertAgent: { id: 'general_task_agent', title: 'General Task Agent' },
    }, stream);

    appendStreamEvent({
      type: 'agent_event',
      eventType: 'subagent_tool_call',
      runId: 'sub_run_error_recovery',
      toolCallId: 'toolu_flaky',
      name: 'web_search',
      input: { query: 'flaky query' },
    }, stream);

    appendStreamEvent({
      type: 'agent_event',
      eventType: 'subagent_tool_result',
      runId: 'sub_run_error_recovery',
      toolCallId: 'toolu_flaky',
      name: 'web_search',
      isError: true,
      output: 'temporary search failure',
      durationMs: 3,
    }, stream);

    assert.equal(stream.blocks[0].status, 'running');
    assert.equal(stream.blocks[0].lastToolError.name, 'web_search');
    assert.equal(stream.blocks[0].blocks.at(-1).status, 'error');

    const runningHtml = renderBlocks(stream.blocks, false);
    assert.match(runningHtml, /running/);
    assert.doesNotMatch(runningHtml, /tool_error/);

    appendStreamEvent({
      type: 'agent_event',
      eventType: 'subagent_done',
      runId: 'sub_run_error_recovery',
      status: 'completed',
      result: { text: 'Recovered with available evidence.' },
    }, stream);

    assert.equal(stream.blocks[0].status, 'completed');
    assert.equal(stream.blocks[0].collapsed, true);
  });

  it('shows subagent server web_search as a nested running tool block', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const stream = {
      conversationId: 'conv1',
      blocks: [],
      renderer: { schedule() {}, flush() {}, cancel() {} },
    };

    appendStreamEvent({
      type: 'agent_event',
      eventType: 'subagent_start',
      runId: 'sub_run_server',
      task: 'Search with server tool',
      expertAgent: { id: 'general_task_agent', title: 'General Task Agent' },
    }, stream);

    appendStreamEvent({
      type: 'agent_event',
      eventType: 'subagent_server_tool',
      runId: 'sub_run_server',
      event: {
        phase: 'call',
        id: 'srv_search_1',
        name: 'web_search',
        input: { query: 'server search query' },
      },
    }, stream);

    assert.equal(stream.blocks[0].blocks.at(-1).type, 'tool-running');
    assert.equal(stream.blocks[0].blocks.at(-1).toolCallId, 'srv_search_1');
    assert.match(stream.blocks[0].blocks.at(-1).label, /server search query/);

    appendStreamEvent({
      type: 'agent_event',
      eventType: 'subagent_server_tool',
      runId: 'sub_run_server',
      event: {
        phase: 'result',
        id: 'srv_search_1',
        name: 'web_search',
        isError: false,
        renderType: 'source-cards',
        data: { sources: [{ title: 'Server Result', url: 'https://example.test/server' }], searchCount: 1 },
      },
    }, stream);

    assert.equal(stream.blocks[0].blocks.at(-1).type, 'source-cards');
    assert.equal(stream.blocks[0].blocks.at(-1).toolCallId, 'srv_search_1');
    assert.equal(stream.blocks[0].blocks.at(-1).sources[0].title, 'Server Result');
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

  it('keeps Feishu media previews expanded and non-collapsible', async () => {
    const { appendStreamEvent } = await import('../public/js/stream-reducer.js');
    const { renderBlocks } = await import('../public/js/renderers.js');
    const stream = {
      conversationId: 'conv1',
      blocks: [],
      renderer: { schedule() {}, flush() {}, cancel() {} },
    };

    appendStreamEvent({
      type: 'tool_result',
      tools: [{
        id: 'toolu_feishu_media',
        name: 'feishu_read',
        renderType: 'feishu-media',
        isError: false,
        data: {
          path: 'feishu:media:image.png',
          filename: 'image.png',
          previewUrl: '/api/v1/tool-assets/feishu-media/image.png',
          contentType: 'image/png',
          size: 425007,
        },
      }],
    }, stream);

    assert.equal(stream.blocks[0].type, 'feishu-media');
    assert.equal(stream.blocks[0].collapsed, false);
    assert.equal(stream.blocks[0].fixedOpen, true);

    const html = renderBlocks([stream.blocks[0]], true);
    assert.match(html, /feishu-media-toggle/);
    assert.match(html, /<img src="\/api\/v1\/tool-assets\/feishu-media\/image\.png"/);
    assert.doesNotMatch(html, /collapsed/);
    assert.doesNotMatch(html, /data-toggle-parent/);
    assert.doesNotMatch(html, /shell-command-toggle-arrow/);
  });

});
