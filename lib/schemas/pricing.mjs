import {
  MAX_MODEL_LEN,
  PRICING_FIELDS,
  PRICING_UNIT,
  fail,
  isPlainObject,
  optionalString,
} from './common.mjs';

function validatePrice(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${field} must be a non-negative number`);
  return n;
}

export function validatePricingRate(value) {
  if (!isPlainObject(value)) fail('pricing entry must be an object');
  const out = {};
  const currency = optionalString(value.currency, 'currency', 3) || 'USD';
  if (!/^[A-Za-z]{3}$/.test(currency)) fail('currency must be a 3-letter ISO code');
  out.currency = currency.toUpperCase();
  out.unit = optionalString(value.unit, 'unit', 40) || PRICING_UNIT;
  if (out.unit !== PRICING_UNIT) fail(`unit must be ${PRICING_UNIT}`);
  for (const field of PRICING_FIELDS) {
    out[field] = validatePrice(value[field], field);
  }
  out.sourceUrl = optionalString(value.sourceUrl, 'sourceUrl', 2_000) || '';
  out.updatedAt = optionalString(value.updatedAt, 'updatedAt', 100) || new Date().toISOString();
  const validUntil = optionalString(value.validUntil, 'validUntil', 100);
  if (validUntil) out.validUntil = validUntil;
  const notes = optionalString(value.notes, 'notes', 1_000);
  if (notes) out.notes = notes;
  return out;
}

export function validateChannelPricing(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return { models: {} };
  if (!isPlainObject(value)) fail('pricing must be an object');
  const rawModels = value.models === undefined ? {} : value.models;
  if (!isPlainObject(rawModels)) fail('pricing.models must be an object');
  const models = {};
  for (const [model, pricing] of Object.entries(rawModels)) {
    const normalizedModel = typeof model === 'string' ? model.trim() : '';
    if (!normalizedModel) continue;
    if (normalizedModel.length > MAX_MODEL_LEN) fail('pricing model is too long');
    models[normalizedModel] = validatePricingRate(pricing);
  }
  return { models };
}
