import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import {
  collectChannelPricingOverrides,
  effectivePricingForChannelModel,
  hideChannelEditor,
  renderChannelList,
  renderSelectors,
  showChannelEditor,
  showChatPage,
} from '../views.js';

export async function loadActive() {
  const data = await api('GET', '/api/v1/active');
  state.channels = data.channels;
  state.activeChannelId = data.activeChannelId;
  state.activeModel = data.activeModel;
  renderSelectors();
}

async function setActiveChannel(channelId) {
  state.activeChannelId = channelId;
  const channel = state.channels.find(item => item.id === channelId);
  if (channel) state.activeModel = channel.models[0] || '';
  await api('POST', '/api/v1/active', { channelId, model: state.activeModel });
  renderSelectors();
}

async function setActiveModel(model) {
  await api('POST', '/api/v1/active', { model });
  state.activeModel = model;
}

async function saveChannel() {
  const id = dom.editChannelId.value;
  const current = state.channels.find(channel => channel.id === id);
  const payload = {
    name: dom.editName.value.trim(),
    baseUrl: dom.editBaseUrl.value.trim(),
    apiKey: dom.editApiKey.value.trim(),
    models: dom.editModels.value.split(',').map(item => item.trim()).filter(Boolean),
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
    renderChannelList();
    renderSelectors();
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
  renderChannelList();
  renderSelectors();
}

async function useChannel(id) {
  await setActiveChannel(id);
  renderChannelList();
  renderSelectors();
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
  dom.channelPricingList.addEventListener('click', handlePricingRowAction);
  dom.btnToggleKey.addEventListener('click', toggleApiKeyVisibility);
}
