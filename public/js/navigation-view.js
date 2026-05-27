import { dom } from './dom.js';
import { renderChannelList } from './channel-view.js';
import { hideToolRunDetail } from './tool-view.js';
import { hideUsageRunDetail } from './usage-dom-view.js';

function hideAllPages() {
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  if (dom.workspacePage) dom.workspacePage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  if (dom.expertAgentsPage) dom.expertAgentsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.add('hidden');
}

export function showChannelsPage() {
  hideUsageRunDetail();
  hideAllPages();
  dom.channelsPage.classList.remove('hidden');
  renderChannelList();
  dom.channelEditor.classList.add('hidden');
}

export function showWorkspacePageFrame() {
  hideToolRunDetail();
  hideUsageRunDetail();
  hideAllPages();
  if (dom.workspacePage) dom.workspacePage.classList.remove('hidden');
}

export function showToolsPageFrame() {
  hideUsageRunDetail();
  hideAllPages();
  dom.toolsPage.classList.remove('hidden');
}

export function showExpertAgentsPageFrame() {
  hideToolRunDetail();
  hideUsageRunDetail();
  hideAllPages();
  if (dom.expertAgentsPage) dom.expertAgentsPage.classList.remove('hidden');
}

export function showUsagePageFrame() {
  hideToolRunDetail();
  hideAllPages();
  dom.usagePage.classList.remove('hidden');
}

export function showPricingPageFrame() {
  hideToolRunDetail();
  hideUsageRunDetail();
  hideAllPages();
  dom.pricingPage.classList.remove('hidden');
}

export function showChatPage() {
  hideToolRunDetail();
  hideUsageRunDetail();
  hideAllPages();
  dom.chatMain.classList.remove('hidden');
}

export function showSettings() {
  dom.settingsModal.classList.remove('hidden');
}

export function hideSettings() {
  dom.settingsModal.classList.add('hidden');
}
