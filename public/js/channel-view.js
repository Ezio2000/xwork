import { dom } from './dom.js';
import {
  effectivePricingForChannelModel as effectivePricingFromBase,
  findBasePricing as findBasePricingFromBase,
  numberOrNull,
  pricingValues,
} from './pricing-view-model.js';
import { escHtml } from './renderers.js';
import { state } from './state.js';

export function modelId(model) {
  return typeof model === 'string' ? model : model?.id || '';
}

function modelLabel(model) {
  return model?.name || modelId(model);
}

export function renderSelectors() {
  dom.channelSelect.innerHTML = state.channels.map(channel =>
    `<option value="${channel.id}" ${channel.id === state.activeChannelId ? 'selected' : ''}>${escHtml(channel.name)}</option>`
  ).join('');

  const channel = state.channels.find(item => item.id === state.activeChannelId);
  const models = channel ? channel.models : [];
  if (models.length && !models.some(model => modelId(model) === state.activeModel)) {
    state.activeModel = modelId(models[0]);
  }
  dom.modelSelect.innerHTML = models.map(model =>
    `<option value="${escHtml(modelId(model))}" ${modelId(model) === state.activeModel ? 'selected' : ''}>${escHtml(modelLabel(model))}</option>`
  ).join('');
}

function findBasePricing(channel, model) {
  return findBasePricingFromBase(state.basePricing, channel, model);
}

export function effectivePricingForChannelModel(channel, model) {
  return effectivePricingFromBase(state.basePricing, channel, model);
}

export function collectChannelPricingOverrides(channel) {
  const models = {};
  for (const row of dom.channelPricingList.querySelectorAll('.channel-pricing-row')) {
    const model = row.dataset.model;
    if (!model) continue;
    const currentOverride = channel?.pricing?.models?.[model];
    const values = {
      currency: 'USD',
      unit: 'per_1m_tokens',
      inputTokenPrice: null,
      cacheReadInputTokenPrice: null,
      cacheCreationInputTokenPrice: null,
      outputTokenPrice: null,
      webSearchRequestPrice: null,
      requestPrice: null,
      sourceUrl: currentOverride?.sourceUrl || '',
      updatedAt: currentOverride?.updatedAt || new Date().toISOString(),
      notes: currentOverride?.notes || '',
    };
    for (const input of row.querySelectorAll('[data-price-field]')) {
      const field = input.dataset.priceField;
      if (field === 'currency') {
        values.currency = (input.value.trim() || 'USD').toUpperCase();
      } else {
        values[field] = numberOrNull(input.value);
      }
    }
    const hasAnyPrice = [
      values.inputTokenPrice,
      values.cacheReadInputTokenPrice,
      values.cacheCreationInputTokenPrice,
      values.outputTokenPrice,
      values.webSearchRequestPrice,
      values.requestPrice,
    ].some(value => value !== null);
    if (hasAnyPrice) models[model] = values;
  }
  return { models };
}

export function renderChannelList() {
  dom.channelList.innerHTML = state.channels.map(channel => `
    <div class="channel-card${channel.id === state.activeChannelId ? ' active' : ''}" data-channel-id="${channel.id}">
      <div class="ch-info">
        <div class="ch-name">${escHtml(channel.name)}</div>
        <div class="ch-meta">${escHtml(channel.baseUrl)} &middot; Anthropic Messages &middot; ${(channel.models || []).length} models</div>
      </div>
      <span class="ch-badge">anthropic</span>
      <div class="ch-actions">
        <button data-action="edit" data-id="${channel.id}">Edit</button>
        <button data-action="delete" data-id="${channel.id}" class="danger">Del</button>
      </div>
    </div>
  `).join('');
}

export function renderVisionConfig({ preserveSelection = false } = {}) {
  const vision = state.vision || {};
  const selectedProviderId = preserveSelection
    ? dom.visionProviderSelect.value
    : (vision.defaultProviderId || '');

  dom.visionFailureAction.innerHTML = [
    `<option value="reject" ${(vision.defaultFailureAction || 'reject') === 'reject' ? 'selected' : ''}>Fail with error</option>`,
    `<option value="remove_images" ${vision.defaultFailureAction === 'remove_images' ? 'selected' : ''}>Remove images and continue</option>`,
    `<option value="ask_user" ${vision.defaultFailureAction === 'ask_user' ? 'selected' : ''}>Ask user</option>`,
  ].join('');

  dom.visionProviderSelect.innerHTML = [
    `<option value="" ${selectedProviderId ? '' : 'selected'}>No default vision provider</option>`,
    ...(state.visionProviders || []).map(provider =>
      `<option value="${escHtml(provider.id)}" ${provider.id === selectedProviderId ? 'selected' : ''}>${escHtml(provider.name || provider.id)}</option>`
    ),
  ].join('');
  dom.visionProviderSelect.value = selectedProviderId;
  renderVisionProviderList();
}

function adapterLabel(adapter) {
  if (adapter === 'anthropic_model') return 'Anthropic model';
  if (adapter === 'http_json') return 'HTTP JSON';
  return adapter || 'unknown';
}

export function renderVisionProviderList() {
  const providers = state.visionProviders || [];
  dom.visionProviderList.innerHTML = providers.length ? providers.map(provider => `
    <div class="vision-provider-row" data-provider-id="${escHtml(provider.id)}">
      <div>
        <div class="vision-provider-name">${escHtml(provider.name || provider.id)}</div>
        <div class="vision-provider-meta">${escHtml(adapterLabel(provider.adapter))} &middot; ${escHtml(provider.id)}</div>
      </div>
      <div class="ch-actions">
        <button data-action="edit-provider" data-id="${escHtml(provider.id)}">Edit</button>
        <button data-action="delete-provider" data-id="${escHtml(provider.id)}" class="danger">Del</button>
      </div>
    </div>
  `).join('') : '<div class="empty-panel">No vision providers configured.</div>';
}

export function showVisionProviderEditor(provider = null) {
  dom.editVisionProviderId.value = provider?.id || '';
  dom.editVisionProviderName.value = provider?.name || '';
  dom.editVisionProviderAdapter.value = provider?.adapter || 'http_json';
  dom.editVisionProviderConfig.value = JSON.stringify(provider?.config || {
    url: 'https://api.minimaxi.com/v1/coding_plan/vlm',
    method: 'POST',
    timeoutMs: 90000,
    headers: { 'MM-API-Source': 'Minimax-MCP' },
    auth: { type: 'bearer', apiKey: '' },
    request: {
      bodyTemplate: {},
      promptPath: 'prompt',
      imagePath: 'image_url',
      imageFormat: 'data_url',
    },
    response: {
      textPath: 'content',
      successPath: 'base_resp.status_code',
      successValue: 0,
      errorCodePath: 'base_resp.status_code',
      errorMessagePath: 'base_resp.status_msg',
      traceHeader: 'trace-id',
    },
  }, null, 2);
  dom.visionProviderEditor.classList.remove('hidden');
}

export function hideVisionProviderEditor() {
  dom.visionProviderEditor.classList.add('hidden');
}

function renderChannelPricingRows(channel) {
  const models = channel?.models || [];
  if (!models.length) {
    return '<div class="empty-panel">No models configured for this channel.</div>';
  }
  return models.map(model => {
    const effective = effectivePricingForChannelModel(channel, model);
    const id = modelId(model);
    const override = channel?.pricing?.models?.[id] || null;
    const pricing = effective.pricing || {};
    const editPricing = override || {};
    const currency = editPricing.currency || pricing.currency || 'USD';
    return `
      <div class="channel-pricing-row" data-model="${escHtml(id)}">
        <div class="channel-pricing-main">
          <div>
            <div class="channel-pricing-model">${escHtml(modelLabel(model))}</div>
            <div class="channel-pricing-values">${escHtml(effective.pricing ? pricingValues(pricing, state.pricingCurrency || 'USD') : 'No pricing configured')}</div>
          </div>
          <span class="pricing-source ${effective.source === 'missing' ? 'missing' : ''}">${escHtml(effective.label)}</span>
        </div>
        <div class="channel-pricing-edit">
          <input data-price-field="inputTokenPrice" type="number" min="0" step="0.000001" placeholder="Input / 1M" value="${editPricing.inputTokenPrice ?? ''}">
          <input data-price-field="cacheReadInputTokenPrice" type="number" min="0" step="0.000001" placeholder="Cache / 1M" value="${editPricing.cacheReadInputTokenPrice ?? ''}">
          <input data-price-field="cacheCreationInputTokenPrice" type="number" min="0" step="0.000001" placeholder="Create / 1M" value="${editPricing.cacheCreationInputTokenPrice ?? ''}">
          <input data-price-field="outputTokenPrice" type="number" min="0" step="0.000001" placeholder="Output / 1M" value="${editPricing.outputTokenPrice ?? ''}">
          <input data-price-field="webSearchRequestPrice" type="number" min="0" step="0.000001" placeholder="Web / req" value="${editPricing.webSearchRequestPrice ?? ''}">
          <input data-price-field="requestPrice" type="number" min="0" step="0.000001" placeholder="Call / req" value="${editPricing.requestPrice ?? ''}">
          <input data-price-field="currency" type="text" placeholder="USD" value="${escHtml(currency)}">
        </div>
        <div class="channel-pricing-actions">
          <button type="button" class="btn-text small" data-action="use-base" ${findBasePricing(channel, model) ? '' : 'disabled'}>Use Base</button>
          <button type="button" class="btn-text small danger" data-action="clear-override">Clear Override</button>
        </div>
      </div>
    `;
  }).join('');
}

export function showChannelEditor(channel) {
  if (channel) {
    dom.editorTitle.textContent = 'Edit Channel';
    dom.editChannelId.value = channel.id;
    dom.editName.value = channel.name || '';
    dom.editBaseUrl.value = channel.baseUrl || '';
    dom.editApiKey.value = channel.apiKey || '';
    dom.editApiKey.type = 'password';
    dom.btnToggleKey.textContent = 'Show';
    dom.editModels.value = JSON.stringify(channel.models || [], null, 2);
    dom.editMaxTokens.value = channel.maxTokens || 8192;
    dom.editMaxTurns.value = channel.maxTurns || 5;
    dom.channelPricingSection.classList.remove('hidden');
    dom.channelPricingList.innerHTML = renderChannelPricingRows(channel);
  } else {
    dom.editorTitle.textContent = 'New Channel';
    dom.editChannelId.value = '';
    dom.editName.value = '';
    dom.editBaseUrl.value = 'https://api.deepseek.com/anthropic';
    dom.editApiKey.value = '';
    dom.editApiKey.type = 'password';
    dom.btnToggleKey.textContent = 'Show';
    dom.editModels.value = JSON.stringify([{
      id: '',
      name: '',
      capabilities: { imageInput: false },
      unsupportedImagePolicy: { action: 'vision_to_text', onVisionFailure: 'reject' },
    }], null, 2);
    dom.editMaxTokens.value = 8192;
    dom.editMaxTurns.value = 5;
    dom.channelPricingSection.classList.add('hidden');
    dom.channelPricingList.innerHTML = '';
  }
  dom.channelEditor.classList.remove('hidden');
}

export function hideChannelEditor() {
  dom.channelEditor.classList.add('hidden');
}
