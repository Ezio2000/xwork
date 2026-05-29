import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import {
  collectChannelPricingOverrides,
  effectivePricingForChannelModel,
  hideChannelEditor,
  hideVisionProviderEditor,
  modelId,
  renderChannelList,
  renderSelectors,
  renderVisionConfig,
  renderVisionProviderList,
  showChannelEditor,
  showChatPage,
  showVisionProviderEditor,
} from '../views.js';

export async function loadActive() {
  const data = await api('GET', '/api/v1/active');
  state.channels = data.channels;
  state.activeChannelId = data.activeChannelId;
  state.activeModel = data.activeModel;
  state.vision = data.vision || { defaultChannelId: null, defaultModelId: null, defaultProviderId: null, defaultProvider: null, defaultFailureAction: 'reject' };
  state.visionProviders = data.visionProviders || [];
  renderSelectors();
  renderVisionConfig();
}

async function setActiveChannel(channelId) {
  state.activeChannelId = channelId;
  const channel = state.channels.find(item => item.id === channelId);
  if (channel) state.activeModel = modelId(channel.models?.[0]) || '';
  await api('POST', '/api/v1/active', { channelId, model: state.activeModel });
  renderSelectors();
}

async function setActiveModel(model) {
  await api('POST', '/api/v1/active', { model });
  state.activeModel = model;
}

function parseModelsFromEditor() {
  const text = dom.editModels.value.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Models must be a JSON array');
    return parsed;
  } catch (err) {
    throw new Error(`Models must be valid JSON: ${err.message || err}`);
  }
}

async function saveChannel() {
  const id = dom.editChannelId.value;
  const current = state.channels.find(channel => channel.id === id);
  const payload = {
    name: dom.editName.value.trim(),
    baseUrl: dom.editBaseUrl.value.trim(),
    apiKey: dom.editApiKey.value.trim(),
    models: parseModelsFromEditor(),
    maxTokens: parseInt(dom.editMaxTokens.value) || 8192,
    maxTurns: parseInt(dom.editMaxTurns.value) || 5,
    pricing: id ? collectChannelPricingOverrides(current) : { models: {} },
  };

  if (!payload.name || !payload.baseUrl) {
    alert('Name and Base URL are required');
    return;
  }

  const previousLabel = dom.btnSaveChannel.textContent;
  dom.btnSaveChannel.disabled = true;
  dom.btnSaveChannel.textContent = 'Saving...';

  try {
    if (id) {
      const updated = await api('PUT', `/api/v1/channels/${id}`, payload);
      const idx = state.channels.findIndex(channel => channel.id === id);
      if (idx !== -1) state.channels[idx] = updated;
    } else {
      const created = await api('POST', '/api/v1/channels', payload);
      state.channels.push(created);
    }

    const active = await api('GET', '/api/v1/active');
    state.activeChannelId = active.activeChannelId;
    state.activeModel = active.activeModel;
    state.vision = active.vision || state.vision;
    state.visionProviders = active.visionProviders || state.visionProviders;
    renderChannelList();
    renderSelectors();
    renderVisionConfig();
    hideChannelEditor();
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    dom.btnSaveChannel.disabled = false;
    dom.btnSaveChannel.textContent = previousLabel;
  }
}

async function deleteChannel(id) {
  if (!confirm('Delete this channel?')) return;
  await api('DELETE', `/api/v1/channels/${id}`);
  state.channels = state.channels.filter(channel => channel.id !== id);
  const data = await api('GET', '/api/v1/active');
  state.activeChannelId = data.activeChannelId;
  state.activeModel = data.activeModel;
  state.vision = data.vision || state.vision;
  state.visionProviders = data.visionProviders || state.visionProviders;
  renderChannelList();
  renderSelectors();
  renderVisionConfig();
}

async function useChannel(id) {
  await setActiveChannel(id);
  renderChannelList();
  renderSelectors();
}

async function saveVisionConfig() {
  const defaultFailureAction = dom.visionFailureAction.value || 'reject';
  const result = await api('PUT', '/api/v1/vision', {
    defaultChannelId: null,
    defaultModelId: null,
    defaultProviderId: dom.visionProviderSelect.value || null,
    defaultProvider: null,
    defaultFailureAction,
  });
  state.vision = result.vision || { defaultChannelId: null, defaultModelId: null, defaultProviderId: null, defaultProvider: null, defaultFailureAction };
  renderVisionConfig();
}

function parseVisionProviderConfig() {
  const text = dom.editVisionProviderConfig.value.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Vision provider config must be valid JSON: ${err.message || err}`);
  }
}

async function saveVisionProvider() {
  const id = dom.editVisionProviderId.value;
  const payload = {
    name: dom.editVisionProviderName.value.trim(),
    adapter: dom.editVisionProviderAdapter.value,
    enabled: true,
    config: parseVisionProviderConfig(),
  };
  const result = id
    ? await api('PUT', `/api/v1/vision-providers/${id}`, payload)
    : await api('POST', '/api/v1/vision-providers', payload);

  if (id) {
    const idx = state.visionProviders.findIndex(provider => provider.id === id);
    if (idx >= 0) state.visionProviders[idx] = result;
  } else {
    state.visionProviders.push(result);
  }
  hideVisionProviderEditor();
  renderVisionConfig();
}

async function deleteVisionProvider(id) {
  if (!confirm('Delete this vision provider?')) return;
  await api('DELETE', `/api/v1/vision-providers/${id}`);
  state.visionProviders = state.visionProviders.filter(provider => provider.id !== id);
  if (state.vision.defaultProviderId === id) state.vision.defaultProviderId = null;
  renderVisionConfig();
}

function copyBasePricingIntoRow(row, channel, model) {
  const effective = effectivePricingForChannelModel({ ...channel, pricing: { models: {} } }, model);
  if (!effective.pricing) return;

  for (const input of row.querySelectorAll('[data-price-field]')) {
    const field = input.dataset.priceField;
    input.value = field === 'currency' ? (effective.pricing.currency || 'USD') : (effective.pricing[field] ?? '');
  }

  row.querySelector('.pricing-source').textContent = 'Channel Override';
  row.querySelector('.pricing-source').classList.remove('missing');
}

function clearPricingOverride(row, channel, model) {
  for (const input of row.querySelectorAll('[data-price-field]')) input.value = '';
  const currencyInput = row.querySelector('[data-price-field="currency"]');
  if (currencyInput) currencyInput.value = 'USD';

  const effective = effectivePricingForChannelModel({ ...channel, pricing: { models: {} } }, model);
  row.querySelector('.pricing-source').textContent = effective.label;
  row.querySelector('.pricing-source').classList.toggle('missing', !effective.pricing);
}

function handlePricingRowAction(event) {
  const row = event.target.closest('.channel-pricing-row');
  if (!row) return;
  const action = event.target.closest('button')?.dataset.action;
  if (!action) return;

  const id = dom.editChannelId.value;
  const channel = state.channels.find(item => item.id === id);
  const model = row.dataset.model;
  if (!channel || !model) return;

  if (action === 'use-base') copyBasePricingIntoRow(row, channel, model);
  if (action === 'clear-override') clearPricingOverride(row, channel, model);
}

function toggleApiKeyVisibility() {
  const input = dom.editApiKey;
  if (input.type === 'password') {
    input.type = 'text';
    dom.btnToggleKey.textContent = 'Hide';
  } else {
    input.type = 'password';
    dom.btnToggleKey.textContent = 'Show';
  }
}

export function bindChannelsController() {
  dom.channelSelect.addEventListener('change', () => setActiveChannel(dom.channelSelect.value));
  dom.modelSelect.addEventListener('change', () => setActiveModel(dom.modelSelect.value));
  dom.btnBackChat.addEventListener('click', showChatPage);
  dom.btnAddChannelPage.addEventListener('click', () => showChannelEditor(null));

  dom.channelList.addEventListener('click', (event) => {
    const card = event.target.closest('.channel-card');
    if (!card) return;
    const id = card.dataset.channelId;
    const btn = event.target.closest('button');
    if (btn) {
      if (btn.dataset.action === 'edit') {
        const channel = state.channels.find(item => item.id === id);
        if (channel) showChannelEditor(channel);
      }
      if (btn.dataset.action === 'delete') deleteChannel(id);
      return;
    }
    if (id !== state.activeChannelId) useChannel(id);
  });

  dom.btnCancelEdit.addEventListener('click', hideChannelEditor);
  dom.btnSaveChannel.addEventListener('click', saveChannel);
  dom.btnSaveVision.addEventListener('click', () => saveVisionConfig().catch(err => alert(err.message || String(err))));
  dom.visionProviderSelect.addEventListener('change', () => renderVisionConfig({ preserveSelection: true }));
  dom.btnAddVisionProvider.addEventListener('click', () => showVisionProviderEditor(null));
  dom.btnCancelVisionProvider.addEventListener('click', hideVisionProviderEditor);
  dom.btnSaveVisionProvider.addEventListener('click', () => saveVisionProvider().catch(err => alert(err.message || String(err))));
  dom.visionProviderList.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.action === 'edit-provider') {
      const provider = state.visionProviders.find(item => item.id === id);
      if (provider) showVisionProviderEditor(provider);
    }
    if (button.dataset.action === 'delete-provider') deleteVisionProvider(id);
  });
  dom.channelPricingList.addEventListener('click', handlePricingRowAction);
  dom.btnToggleKey.addEventListener('click', toggleApiKeyVisibility);
}
