import { dom } from './dom.js';
import { state } from './state.js';
import {
  hideSettings,
  showChannelEditor,
  showChannelsPage,
  showVisionProviderEditor,
} from './views.js';

let showToolsPageHandler = null;

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function channelNeedsKey(channel) {
  return !hasValue(channel?.apiKey);
}

function providerNeedsKey(provider) {
  return provider?.enabled !== false
    && provider?.adapter === 'http_json'
    && provider?.config?.auth?.type === 'bearer'
    && !hasValue(provider?.config?.auth?.apiKey);
}

function feishuNeedsAppSecret(tool) {
  if (!tool || tool.enabled === false) return false;
  const config = tool.config || {};
  return hasValue(config.app_id || config.appId) && !hasValue(config.app_secret || config.appSecret);
}

export function sensitiveSetupItems() {
  const activeChannel = state.channels.find(channel => channel.id === state.activeChannelId);
  const channel = activeChannel || state.channels[0] || null;
  const visionProvider = (state.visionProviders || []).find(providerNeedsKey) || null;
  const feishuAuth = (state.tools || []).find(tool => tool.id === 'feishu_auth') || null;

  return [
    {
      id: 'chat-api-key',
      title: 'Chat API key',
      description: channel
        ? `Required before chatting through ${channel.name || channel.id}.`
        : 'Required before chatting with an API provider.',
      status: channel && !channelNeedsKey(channel) ? 'ready' : 'missing',
      action: 'open-channel',
      actionLabel: 'Open Channel',
    },
    {
      id: 'vision-api-key',
      title: 'Vision fallback key',
      description: visionProvider
        ? `Required when ${visionProvider.name || visionProvider.id} converts images to text.`
        : 'No enabled HTTP bearer vision provider is missing a key.',
      status: visionProvider ? 'missing' : 'ready',
      action: 'open-vision',
      actionLabel: 'Open Vision',
    },
    {
      id: 'feishu-app-secret',
      title: 'Feishu app secret',
      description: feishuAuth
        ? 'Required only if you use Feishu authorization and document tools.'
        : 'Feishu authorization tool is not available.',
      status: feishuNeedsAppSecret(feishuAuth) ? 'missing' : 'ready',
      action: 'open-feishu',
      actionLabel: 'Open Tools',
    },
  ];
}

function missingItems() {
  return sensitiveSetupItems().filter(item => item.status === 'missing');
}

function renderGuide() {
  const items = sensitiveSetupItems();
  const missing = items.filter(item => item.status === 'missing');
  dom.sensitiveSetupStatus.innerHTML = `
    <div class="sensitive-setup-summary ${missing.length ? 'missing' : 'ready'}">
      ${missing.length
        ? `${missing.length} sensitive item${missing.length === 1 ? '' : 's'} need local values.`
        : 'All sensitive items currently have local values or are not required.'}
    </div>
    <div class="sensitive-setup-list">
      ${items.map(item => `
        <div class="sensitive-setup-item ${item.status}">
          <div>
            <div class="sensitive-setup-item-title">${item.title}</div>
            <div class="sensitive-setup-item-desc">${item.description}</div>
          </div>
          <div class="sensitive-setup-item-side">
            <span>${item.status === 'ready' ? 'Ready' : 'Missing'}</span>
            <button type="button" class="btn-text small" data-sensitive-action="${item.action}" ${item.status === 'ready' ? 'disabled' : ''}>${item.actionLabel}</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="sensitive-setup-note">
      API keys, bearer tokens, app secrets, and OAuth tokens stay local in xwork config storage. Use environment-specific values on each machine.
    </div>
  `;
}

export function showSensitiveSetupGuide() {
  renderGuide();
  dom.sensitiveSetupModal.classList.remove('hidden');
}

export function hideSensitiveSetupGuide() {
  dom.sensitiveSetupModal.classList.add('hidden');
}

function openChannelSetup() {
  hideSensitiveSetupGuide();
  const channel = state.channels.find(channel => channel.id === state.activeChannelId) || state.channels[0] || null;
  showChannelsPage();
  if (channel) showChannelEditor(channel);
  requestAnimationFrame(() => dom.editApiKey?.focus?.());
}

function openVisionSetup() {
  hideSensitiveSetupGuide();
  const provider = (state.visionProviders || []).find(providerNeedsKey) || null;
  showChannelsPage();
  if (provider) showVisionProviderEditor(provider);
  requestAnimationFrame(() => dom.editVisionProviderConfig?.focus?.());
}

async function openFeishuSetup() {
  hideSensitiveSetupGuide();
  if (typeof showToolsPageHandler === 'function') await showToolsPageHandler();
  requestAnimationFrame(() => {
    const card = dom.toolList?.querySelector?.('[data-tool-id="feishu_auth"]');
    const details = card?.querySelector?.('details');
    if (details) details.open = true;
    card?.scrollIntoView?.({ block: 'center' });
    card?.querySelector?.('[data-config-key="app_secret"]')?.focus?.();
  });
}

export function bindSensitiveSetupGuide({ showToolsPage } = {}) {
  showToolsPageHandler = showToolsPage;
  dom.settingSensitiveSetup?.addEventListener('click', () => {
    hideSettings();
    showSensitiveSetupGuide();
  });
  dom.btnCloseSensitiveSetup?.addEventListener('click', () => hideSensitiveSetupGuide());
  dom.btnSensitiveSetupDismiss?.addEventListener('click', () => hideSensitiveSetupGuide());
  dom.sensitiveSetupModal?.querySelector?.('.modal-backdrop')?.addEventListener('click', () => hideSensitiveSetupGuide());
  dom.sensitiveSetupStatus?.addEventListener('click', (event) => {
    const action = event.target?.closest?.('[data-sensitive-action]')?.dataset?.sensitiveAction;
    if (action === 'open-channel') openChannelSetup();
    if (action === 'open-vision') openVisionSetup();
    if (action === 'open-feishu') openFeishuSetup().catch(err => alert(err.message || String(err)));
  });
}
