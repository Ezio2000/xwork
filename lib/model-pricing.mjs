import { SchemaValidationError, isPlainObject, isSafeId } from './schema.mjs';

export const PRICING_UNIT = 'per_1m_tokens';
export const PRICING_FIELDS = [
  'inputTokenPrice',
  'cacheReadInputTokenPrice',
  'cacheCreationInputTokenPrice',
  'outputTokenPrice',
  'webSearchRequestPrice',
];

export const DEFAULT_BASE_PRICING = [
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-flash',
    currency: 'USD',
    unit: PRICING_UNIT,
    inputTokenPrice: 0.14,
    cacheReadInputTokenPrice: 0.0028,
    cacheCreationInputTokenPrice: 0.14,
    outputTokenPrice: 0.28,
    webSearchRequestPrice: null,
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    updatedAt: '2026-05-17',
    notes: 'DeepSeek official public pricing. Web search request pricing is not listed on the model pricing page.',
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-pro',
    currency: 'USD',
    unit: PRICING_UNIT,
    inputTokenPrice: 0.435,
    cacheReadInputTokenPrice: 0.003625,
    cacheCreationInputTokenPrice: 0.435,
    outputTokenPrice: 0.87,
    webSearchRequestPrice: null,
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    updatedAt: '2026-05-17',
    validUntil: '2026-05-31T15:59:00Z',
    notes: 'DeepSeek v4 pro 75% promotional pricing shown on the official pricing page as of 2026-05-17.',
  },
];

const FIELD_LABELS = {
  inputTokenPrice: 'inputTokenPrice',
  cacheReadInputTokenPrice: 'cacheReadInputTokenPrice',
  cacheCreationInputTokenPrice: 'cacheCreationInputTokenPrice',
  outputTokenPrice: 'outputTokenPrice',
  webSearchRequestPrice: 'webSearchRequestPrice',
};

function fail(message) {
  throw new SchemaValidationError(message);
}

function trimString(value, field, maxLen, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.length > maxLen) fail(`${field} is too long`);
  return value.trim();
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.toString().replace(/\/+$/, '');
  } catch {
    return text.replace(/\/+$/, '');
  }
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCurrency(value) {
  const text = String(value || 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(text)) fail('currency must be a 3-letter ISO code');
  return text;
}

function normalizePrice(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${field} must be a non-negative number`);
  return n;
}

export function validatePricingRates(payload = {}, { partial = false } = {}) {
  if (!isPlainObject(payload)) fail('pricing must be an object');
  const out = {};

  if (!partial || payload.currency !== undefined) out.currency = normalizeCurrency(payload.currency);
  if (!partial || payload.unit !== undefined) {
    const unit = trimString(payload.unit, 'unit', 40) || PRICING_UNIT;
    if (unit !== PRICING_UNIT) fail(`unit must be ${PRICING_UNIT}`);
    out.unit = unit;
  }

  for (const field of PRICING_FIELDS) {
    if (!partial || payload[field] !== undefined) {
      out[field] = normalizePrice(payload[field], field);
    }
  }

  if (payload.sourceUrl !== undefined || !partial) {
    out.sourceUrl = trimString(payload.sourceUrl, 'sourceUrl', 2_000);
  }
  if (payload.updatedAt !== undefined || !partial) {
    out.updatedAt = trimString(payload.updatedAt, 'updatedAt', 100) || new Date().toISOString();
  }
  if (payload.validUntil !== undefined) {
    out.validUntil = trimString(payload.validUntil, 'validUntil', 100);
  }
  if (payload.notes !== undefined) {
    out.notes = trimString(payload.notes, 'notes', 1_000);
  }

  return out;
}

export function validateBasePricingEntry(payload = {}, { partial = false } = {}) {
  if (!isPlainObject(payload)) fail('pricing entry must be an object');
  const out = validatePricingRates(payload, { partial });

  if (!partial || payload.id !== undefined) {
    const id = trimString(payload.id, 'id', 128, { required: !partial });
    if (id && !isSafeId(id)) fail('id must be a safe id');
    if (id) out.id = id;
  }
  if (!partial || payload.provider !== undefined) {
    out.provider = normalizeProvider(trimString(payload.provider, 'provider', 120));
  }
  if (!partial || payload.baseUrl !== undefined) {
    out.baseUrl = normalizeBaseUrl(trimString(payload.baseUrl, 'baseUrl', 2_000));
  }
  if (!partial || payload.model !== undefined) {
    out.model = trimString(payload.model, 'model', 200, { required: !partial });
  }

  return out;
}

export function normalizeBasePricingEntries(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(entry => {
      try {
        return validateBasePricingEntry(entry);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function validateChannelPricing(payload = {}) {
  if (payload === undefined || payload === null || payload === '') return { models: {} };
  if (!isPlainObject(payload)) fail('pricing must be an object');
  const rawModels = payload.models === undefined ? {} : payload.models;
  if (!isPlainObject(rawModels)) fail('pricing.models must be an object');

  const models = {};
  for (const [model, rawPricing] of Object.entries(rawModels)) {
    const normalizedModel = trimString(model, 'pricing model', 200);
    if (!normalizedModel) continue;
    models[normalizedModel] = validatePricingRates(rawPricing);
  }

  return { models };
}

export function inferProviderFromChannel(channel = {}) {
  if (!channel) return '';
  const baseUrl = channel.baseUrl || '';
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes('deepseek.com')) return 'deepseek';
    if (host.includes('anthropic.com')) return 'anthropic';
    if (host.includes('openai.com')) return 'openai';
    if (host.includes('googleapis.com') || host.includes('generativelanguage.googleapis.com')) return 'google';
  } catch {}

  const name = normalizeProvider(channel.name);
  if (name.includes('deepseek')) return 'deepseek';
  if (name.includes('anthropic') || name.includes('claude')) return 'anthropic';
  if (name.includes('openai')) return 'openai';
  if (name.includes('google') || name.includes('gemini')) return 'google';
  return '';
}

export function findEffectiveModelPricing({ channel, model, basePricing = [] } = {}) {
  if (!model) {
    return { pricing: null, source: 'missing', key: null, missingReason: 'model_missing' };
  }

  const channelPricing = channel?.pricing?.models?.[model];
  if (channelPricing) {
    return {
      pricing: channelPricing,
      source: 'channel_override',
      key: `channel:${channel.id || 'unknown'}:${model}`,
    };
  }

  const entries = Array.isArray(basePricing) ? basePricing : [];
  const baseUrl = normalizeBaseUrl(channel?.baseUrl);
  const provider = inferProviderFromChannel(channel);
  const exactBase = entries.find(entry => (
    entry.model === model
    && entry.baseUrl
    && normalizeBaseUrl(entry.baseUrl) === baseUrl
  ));
  if (exactBase) {
    return {
      pricing: exactBase,
      source: 'base_default',
      key: `base:${exactBase.id}`,
    };
  }

  const providerMatch = entries.find(entry => (
    entry.model === model
    && entry.provider
    && normalizeProvider(entry.provider) === provider
  ));
  if (providerMatch) {
    return {
      pricing: providerMatch,
      source: 'base_default',
      key: `base:${providerMatch.id}`,
    };
  }

  return { pricing: null, source: 'missing', key: null, missingReason: 'pricing_missing' };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function costFor({ count, pricing, field, perRequest = false }) {
  if (count <= 0) return { cost: 0, missing: false };
  const price = pricing?.[field];
  if (price === undefined || price === null || price === '' || !Number.isFinite(Number(price))) {
    return { cost: 0, missing: true, field: FIELD_LABELS[field] || field };
  }
  return {
    cost: perRequest ? count * Number(price) : (count / 1_000_000) * Number(price),
    missing: false,
  };
}

export function calculateUsageCost(usage, effectivePricing) {
  if (!usage) {
    return {
      pricingStatus: 'not_applicable',
      pricingSource: effectivePricing?.source || 'missing',
      pricingKey: effectivePricing?.key || null,
      currency: effectivePricing?.pricing?.currency || null,
      inputCost: 0,
      cacheReadInputCost: 0,
      cacheCreationInputCost: 0,
      outputCost: 0,
      webSearchCost: 0,
      totalCost: 0,
      missingFields: [],
      unpricedUsage: [],
    };
  }

  const pricing = effectivePricing?.pricing || null;
  if (!pricing) {
    return {
      pricingStatus: 'missing',
      pricingSource: 'missing',
      pricingKey: null,
      currency: null,
      inputCost: null,
      cacheReadInputCost: null,
      cacheCreationInputCost: null,
      outputCost: null,
      webSearchCost: null,
      totalCost: null,
      missingFields: ['pricing'],
      unpricedUsage: [],
    };
  }

  const parts = {
    inputCost: costFor({ count: num(usage?.input_tokens), pricing, field: 'inputTokenPrice' }),
    cacheReadInputCost: costFor({ count: num(usage?.cache_read_input_tokens), pricing, field: 'cacheReadInputTokenPrice' }),
    cacheCreationInputCost: costFor({ count: num(usage?.cache_creation_input_tokens), pricing, field: 'cacheCreationInputTokenPrice' }),
    outputCost: costFor({ count: num(usage?.output_tokens), pricing, field: 'outputTokenPrice' }),
    webSearchCost: costFor({
      count: num(usage?.server_tool_use?.web_search_requests),
      pricing,
      field: 'webSearchRequestPrice',
      perRequest: true,
    }),
  };

  const missingFields = [];
  const unpricedUsage = [];
  let totalCost = 0;
  for (const [key, result] of Object.entries(parts)) {
    if (result.missing) {
      missingFields.push(result.field);
      if (key === 'webSearchCost') unpricedUsage.push('webSearchRequests');
      continue;
    }
    totalCost += result.cost;
  }

  return {
    pricingStatus: missingFields.length ? 'partial' : 'estimated',
    pricingSource: effectivePricing.source,
    pricingKey: effectivePricing.key,
    currency: pricing.currency || 'USD',
    inputCost: parts.inputCost.missing ? null : parts.inputCost.cost,
    cacheReadInputCost: parts.cacheReadInputCost.missing ? null : parts.cacheReadInputCost.cost,
    cacheCreationInputCost: parts.cacheCreationInputCost.missing ? null : parts.cacheCreationInputCost.cost,
    outputCost: parts.outputCost.missing ? null : parts.outputCost.cost,
    webSearchCost: parts.webSearchCost.missing ? null : parts.webSearchCost.cost,
    totalCost,
    missingFields,
    unpricedUsage,
  };
}

export function publicPricingEntry(entry) {
  return { ...entry };
}
