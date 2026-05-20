import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteDocumentStore } from './sqlite-store.mjs';
import {
  DEFAULT_BASE_PRICING,
  normalizeBasePricingEntries,
  publicPricingEntry,
  validateBasePricingEntry,
} from './model-pricing.mjs';
import { validateSafeId } from './schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = join(__dirname, '..', 'data', 'model-pricing.json');

const pricingStore = createSqliteDocumentStore({
  key: 'model-pricing',
  legacyFilePath: PRICING_PATH,
  defaultValue: { basePricing: DEFAULT_BASE_PRICING },
  normalize: data => ({
    basePricing: normalizeBasePricingEntries(data?.basePricing),
  }),
  serialize: data => ({
    basePricing: normalizeBasePricingEntries(data.basePricing),
  }),
});

function updatePricingData(mutator) {
  return pricingStore.update(mutator);
}

export async function listBasePricing() {
  const data = await pricingStore.read();
  return data.basePricing.map(publicPricingEntry);
}

export async function getBasePricingEntries() {
  const data = await pricingStore.read();
  return data.basePricing;
}

export async function createBasePricingEntry(payload) {
  const entry = validateBasePricingEntry(payload);
  return updatePricingData((data) => {
    if (data.basePricing.some(item => item.id === entry.id)) {
      return { error: 'Pricing entry already exists', status: 409 };
    }
    data.basePricing.push(entry);
    return publicPricingEntry(entry);
  });
}

export async function updateBasePricingEntry(id, payload) {
  const safeId = validateSafeId(id, 'pricingId');
  const patch = validateBasePricingEntry(payload, { partial: true });
  return updatePricingData((data) => {
    const idx = data.basePricing.findIndex(item => item.id === safeId);
    if (idx === -1) return { error: 'Pricing entry not found', status: 404 };
    const next = { ...data.basePricing[idx], ...patch, id: safeId };
    data.basePricing[idx] = validateBasePricingEntry(next);
    return publicPricingEntry(data.basePricing[idx]);
  });
}

export async function deleteBasePricingEntry(id) {
  const safeId = validateSafeId(id, 'pricingId');
  return updatePricingData((data) => {
    const idx = data.basePricing.findIndex(item => item.id === safeId);
    if (idx === -1) return { error: 'Pricing entry not found', status: 404 };
    data.basePricing.splice(idx, 1);
    return { ok: true };
  });
}
