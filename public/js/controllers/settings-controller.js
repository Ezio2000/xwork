import { dom } from '../dom.js';
import { hideSettings, showChannelsPage, showChatPage, showSettings } from '../views.js';

export function bindSettingsController({ showPricingPage, showToolsPage, showUsagePage, showWorkspacePage }) {
  dom.logo.addEventListener('click', showChatPage);

  dom.btnSettings.addEventListener('click', showSettings);
  dom.btnCloseSettings.addEventListener('click', hideSettings);
  dom.settingsModal.querySelector('.modal-backdrop').addEventListener('click', hideSettings);

  dom.settingChannels.addEventListener('click', () => {
    hideSettings();
    showChannelsPage();
  });
  if (dom.settingWorkspace && typeof showWorkspacePage === 'function') {
    dom.settingWorkspace.addEventListener('click', () => {
      hideSettings();
      showWorkspacePage();
    });
  }
  dom.settingTools.addEventListener('click', () => {
    hideSettings();
    showToolsPage();
  });
  dom.settingUsage.addEventListener('click', () => {
    hideSettings();
    showUsagePage();
  });
  dom.settingPricing.addEventListener('click', () => {
    hideSettings();
    showPricingPage();
  });
}
