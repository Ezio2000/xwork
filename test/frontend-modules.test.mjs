import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function fakeClassList() {
  return {
    add() {},
    remove() {},
    toggle() {},
    contains() {
      return false;
    },
  };
}

function fakeElement() {
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
    appendChild() {},
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
  querySelector() {
    return fakeElement();
  },
};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.window = { CSS: { escape: String } };
globalThis.CSS = { escape: String };
globalThis.marked = {
  parse(value) {
    return String(value || '');
  },
  setOptions() {},
};
globalThis.katex = {
  renderToString(value) {
    return String(value || '');
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
      import('../public/js/controllers/chat-input-controller.js'),
      import('../public/js/controllers/conversations-controller.js'),
      import('../public/js/controllers/pricing-controller.js'),
      import('../public/js/controllers/settings-controller.js'),
      import('../public/js/controllers/tools-controller.js'),
      import('../public/js/controllers/usage-controller.js'),
    ]);

    assert.equal(typeof modules[0].bindChannelsController, 'function');
    assert.equal(typeof modules[0].loadActive, 'function');
    assert.equal(typeof modules[1].bindChatInputController, 'function');
    assert.equal(typeof modules[2].bindConversationsController, 'function');
    assert.equal(typeof modules[2].loadConversations, 'function');
    assert.equal(typeof modules[2].selectConversation, 'function');
    assert.equal(typeof modules[3].bindPricingController, 'function');
    assert.equal(typeof modules[3].loadBasePricing, 'function');
    assert.equal(typeof modules[3].showPricingPage, 'function');
    assert.equal(typeof modules[4].bindSettingsController, 'function');
    assert.equal(typeof modules[5].bindToolsController, 'function');
    assert.equal(typeof modules[5].showToolsPage, 'function');
    assert.equal(typeof modules[6].bindUsageController, 'function');
    assert.equal(typeof modules[6].showUsagePage, 'function');
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

  it('renders mysql query results as a collapsible table', async () => {
    const { renderBlocks } = await import('../public/js/renderers.js');
    const html = renderBlocks([{
      type: 'mysql-query',
      source: { id: 'dev', host: '127.0.0.1', database: 'biz' },
      sql: 'select 1 as n',
      rowCount: 1,
      returnedRowCount: 1,
      columns: ['n'],
      previewRows: [{ n: 1 }],
    }], false);

    assert.match(html, /mysql-query-table/);
    assert.match(html, /select 1 as n/);
    assert.match(html, /dev/);
  });

  it('renders sqlite query results with the shared database table renderer', async () => {
    const { renderBlocks } = await import('../public/js/renderers.js');
    const html = renderBlocks([{
      type: 'sqlite-query',
      source: { id: 'xwork', path: 'data/xwork.sqlite' },
      sql: 'select name from sqlite_master',
      rowCount: 1,
      returnedRowCount: 1,
      columns: ['name'],
      previewRows: [{ name: 'documents' }],
    }], false);

    assert.match(html, /mysql-query-table/);
    assert.match(html, /data\/xwork\.sqlite/);
    assert.match(html, /documents/);
  });
});
