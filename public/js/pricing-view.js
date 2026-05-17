import { dom } from './dom.js';
import { fmtPrice, numberOrNull } from './pricing-view-model.js';
import { escHtml } from './renderers.js';
import { state } from './state.js';

function pricingPayloadFromDom(prefix = 'editPricing') {
  return {
    provider: dom[`${prefix}Provider`]?.value?.trim(),
    model: dom[`${prefix}Model`]?.value?.trim(),
    currency: (dom[`${prefix}Currency`]?.value?.trim() || 'USD').toUpperCase(),
    unit: 'per_1m_tokens',
    inputTokenPrice: numberOrNull(dom[`${prefix}Input`]?.value),
    cacheReadInputTokenPrice: numberOrNull(dom[`${prefix}CacheRead`]?.value),
    cacheCreationInputTokenPrice: numberOrNull(dom[`${prefix}CacheCreate`]?.value),
    outputTokenPrice: numberOrNull(dom[`${prefix}Output`]?.value),
    webSearchRequestPrice: numberOrNull(dom[`${prefix}WebSearch`]?.value),
    requestPrice: numberOrNull(dom[`${prefix}Request`]?.value),
    sourceUrl: dom[`${prefix}SourceUrl`]?.value?.trim() || '',
    updatedAt: dom[`${prefix}UpdatedAt`]?.value?.trim() || new Date().toISOString(),
    notes: dom[`${prefix}Notes`]?.value?.trim() || '',
  };
}

export function renderBasePricing() {
  if (dom.pricingDisplayCurrency) dom.pricingDisplayCurrency.value = state.pricingCurrency || 'USD';
  if (!state.basePricing.length) {
    dom.pricingCountLabel.textContent = '0 models';
    dom.pricingList.innerHTML = '<div class="empty-panel">No base pricing configured.</div>';
    return;
  }
  dom.pricingCountLabel.textContent = `${state.basePricing.length} model${state.basePricing.length === 1 ? '' : 's'}`;

  const rows = state.basePricing.map(entry => {
    const currency = entry.currency || 'USD';
    return `
      <div class="pricing-row" data-pricing-id="${escHtml(entry.id)}">
        <div class="pricing-identity">
          <div class="pricing-model">${escHtml(entry.model)}</div>
          <div class="pricing-meta">${escHtml(entry.provider || 'unknown')}</div>
        </div>
        <div class="price-cell"><span>Input</span><strong>${escHtml(fmtPrice(entry.inputTokenPrice, currency, state.pricingCurrency || 'USD'))}</strong></div>
        <div class="price-cell"><span>Output</span><strong>${escHtml(fmtPrice(entry.outputTokenPrice, currency, state.pricingCurrency || 'USD'))}</strong></div>
        <div class="price-cell"><span>Cache</span><strong>${escHtml(fmtPrice(entry.cacheReadInputTokenPrice, currency, state.pricingCurrency || 'USD'))}</strong></div>
        <div class="price-cell"><span>Create</span><strong>${escHtml(fmtPrice(entry.cacheCreationInputTokenPrice, currency, state.pricingCurrency || 'USD'))}</strong></div>
        <div class="price-cell"><span>Call</span><strong>${escHtml(fmtPrice(entry.requestPrice ?? 0, currency, state.pricingCurrency || 'USD'))}</strong></div>
        <div class="pricing-actions">
          <button class="btn-text small" data-action="edit-pricing">Edit</button>
          <button class="btn-text small danger" data-action="delete-pricing">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  dom.pricingList.innerHTML = `
    <div class="pricing-table">
      <div class="pricing-table-head">
        <span>Model</span>
        <span>Input</span>
        <span>Output</span>
        <span>Cache</span>
        <span>Create</span>
        <span>Call</span>
        <span></span>
      </div>
      ${rows}
    </div>
  `;
}

export function showPricingEditor(entry) {
  dom.pricingEditorTitle.textContent = entry ? 'Edit Base Price' : 'New Base Price';
  dom.editPricingId.value = entry?.id || '';
  dom.editPricingProvider.value = entry?.provider || '';
  dom.editPricingModel.value = entry?.model || '';
  dom.editPricingCurrency.value = entry?.currency || 'USD';
  dom.editPricingInput.value = entry?.inputTokenPrice ?? '';
  dom.editPricingCacheRead.value = entry?.cacheReadInputTokenPrice ?? '';
  dom.editPricingCacheCreate.value = entry?.cacheCreationInputTokenPrice ?? '';
  dom.editPricingOutput.value = entry?.outputTokenPrice ?? '';
  dom.editPricingWebSearch.value = entry?.webSearchRequestPrice ?? '';
  dom.editPricingRequest.value = entry?.requestPrice ?? '';
  dom.editPricingSourceUrl.value = entry?.sourceUrl || '';
  dom.editPricingUpdatedAt.value = entry?.updatedAt || new Date().toISOString().slice(0, 10);
  dom.editPricingNotes.value = entry?.notes || '';
  dom.pricingEditor.classList.remove('hidden');
}

export function hidePricingEditor() {
  dom.pricingEditor.classList.add('hidden');
}

export function pricingPayloadFromEditor() {
  const payload = pricingPayloadFromDom();
  if (!dom.editPricingId.value) {
    const rawId = [payload.provider, payload.model].filter(Boolean).join('-');
    payload.id = rawId ? rawId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) : '';
  }
  return payload;
}
