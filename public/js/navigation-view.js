import { dom } from './dom.js';
import { renderChannelList } from './channel-view.js';
import { hideToolRunDetail } from './tool-view.js';
import { hideUsageRunDetail } from './usage-dom-view.js';

export function showChannelsPage() {
  hideUsageRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.add('hidden');
  dom.channelsPage.classList.remove('hidden');
  renderChannelList();
  dom.channelEditor.classList.add('hidden');
}

export function showToolsPageFrame() {
  hideUsageRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.remove('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.add('hidden');
}

export function showUsagePageFrame() {
  hideToolRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.remove('hidden');
  dom.pricingPage.classList.add('hidden');
}

export function showPricingPageFrame() {
  hideToolRunDetail();
  hideUsageRunDetail();
  dom.chatMain.classList.add('hidden');
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.remove('hidden');
}

export function showChatPage() {
  hideToolRunDetail();
  hideUsageRunDetail();
  dom.channelsPage.classList.add('hidden');
  dom.toolsPage.classList.add('hidden');
  dom.usagePage.classList.add('hidden');
  dom.pricingPage.classList.add('hidden');
  dom.chatMain.classList.remove('hidden');
}

export function showSettings() {
  dom.settingsModal.classList.remove('hidden');
}

export function hideSettings() {
  dom.settingsModal.classList.add('hidden');
}
