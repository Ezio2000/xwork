import { api } from '../api-client.js';
import { dom } from '../dom.js';
import { state } from '../state.js';
import {
  hidePricingEditor,
  pricingPayloadFromEditor,
  renderBasePricing,
  renderChannelList,
  showChatPage,
  showPricingEditor,
  showPricingPageFrame,
} from '../views.js';

export async function loadBasePricing() {
  state.basePricing = await api('GET', '/api/v1/model-pricing');
  renderBasePricing();
}

export async function showPricingPage() {
  showPricingPageFrame();
  await loadBasePricing();
}

async function saveBasePricing() {
  const id = dom.editPricingId.value;
  const payload = pricingPayloadFromEditor();
  if (!payload.id && !id) {
    alert('Model is required');
    return;
  }
  if (!payload.provider || !payload.model) {
    alert('Provider and model are required');
    return;
  }
  if (id) {
    const updated = await api('PUT', `/api/v1/model-pricing/${id}`, payload);
    const idx = state.basePricing.findIndex(item => item.id === id);
    if (idx !== -1) state.basePricing[idx] = updated;
  } else {
    const created = await api('POST', '/api/v1/model-pricing', payload);
    state.basePricing.push(created);
  }
  renderBasePricing();
  renderChannelList();
  hidePricingEditor();
}

async function deleteBasePricing(id) {
  if (!confirm('Delete this base price? Channel overrides will not be deleted.')) return;
  await api('DELETE', `/api/v1/model-pricing/${id}`);
  state.basePricing = state.basePricing.filter(item => item.id !== id);
  renderBasePricing();
}

export function bindPricingController() {
  dom.btnBackChatPricing.addEventListener('click', showChatPage);
  dom.btnRefreshPricing.addEventListener('click', loadBasePricing);
  dom.btnAddPricing.addEventListener('click', () => showPricingEditor(null));
  dom.pricingDisplayCurrency.addEventListener('change', () => {
    state.pricingCurrency = dom.pricingDisplayCurrency.value || 'USD';
    renderBasePricing();
    renderChannelList();
  });
  dom.btnCancelPricing.addEventListener('click', hidePricingEditor);
  dom.btnSavePricing.addEventListener('click', saveBasePricing);
  dom.pricingList.addEventListener('click', (event) => {
    const row = event.target.closest('.pricing-row');
    if (!row) return;
    const id = row.dataset.pricingId;
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'edit-pricing') {
      const entry = state.basePricing.find(item => item.id === id);
      if (entry) showPricingEditor(entry);
    }
    if (action === 'delete-pricing') {
      deleteBasePricing(id).catch(err => alert(err.message));
    }
  });
}
