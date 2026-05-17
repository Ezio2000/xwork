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
});
