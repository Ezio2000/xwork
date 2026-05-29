import { bindChannelsController, loadActive } from './js/controllers/channels-controller.js';
import { bindChatHeaderController, renderChatHeaderActions } from './js/controllers/chat-header-controller.js';
import { bindChatInputController } from './js/controllers/chat-input-controller.js';
import { bindFileMentionController } from './js/controllers/file-mention-controller.js';
import { bindImageAttachments } from './js/image-attachments.js';
import {
  bindConversationsController,
  loadConversations,
  selectConversation,
} from './js/controllers/conversations-controller.js';
import { bindExpertAgentsController, showExpertAgentsPage } from './js/controllers/expert-agents-controller.js';
import { bindPricingController, loadBasePricing, showPricingPage } from './js/controllers/pricing-controller.js';
import { bindSettingsController } from './js/controllers/settings-controller.js';
import { bindToolsController, loadTools, showToolsPage } from './js/controllers/tools-controller.js';
import { bindUsageController, showUsagePage } from './js/controllers/usage-controller.js';
import { bindWorkspaceController, showWorkspacePage } from './js/controllers/workspace-controller.js';
import { dom } from './js/dom.js';
import { installRendererEventHandlers } from './js/renderers.js';
import { state } from './js/state.js';
import { renderMessages } from './js/views.js';

function bindEvents() {
  installRendererEventHandlers(document);
  bindChatHeaderController();
  bindChatInputController();
  bindFileMentionController();
  bindImageAttachments();
  bindConversationsController();
  bindSettingsController({ showExpertAgentsPage, showPricingPage, showToolsPage, showUsagePage, showWorkspacePage });
  bindChannelsController();
  bindToolsController();
  bindExpertAgentsController();
  bindUsageController();
  bindPricingController();
  bindWorkspaceController();
}

async function init() {
  bindEvents();
  await loadBasePricing();
  await loadTools();
  renderChatHeaderActions();
  await loadActive();
  await loadConversations();
  if (state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id);
  } else {
    renderMessages();
  }
  dom.msgInput.focus();
}

init();
