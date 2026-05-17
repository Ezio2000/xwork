import { PRICING_SOURCE, pricingSourceLabel } from './pricing-protocol.js';

const USD_EXCHANGE_RATES = {
  USD: 1,
  CNY: 7.2,
  EUR: 0.92,
  HKD: 7.8,
};

export function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return new URL(text).toString().replace(/\/+$/, '');
  } catch {
    return text.replace(/\/+$/, '');
  }
}

export function inferProvider(channel = {}) {
  const baseUrl = normalizeBaseUrl(channel.baseUrl).toLowerCase();
  if (baseUrl.includes('deepseek.com')) return 'deepseek';
  if (baseUrl.includes('anthropic.com')) return 'anthropic';
  if (baseUrl.includes('openai.com')) return 'openai';
  if (baseUrl.includes('googleapis.com')) return 'google';
  const name = String(channel.name || '').toLowerCase();
  if (name.includes('deepseek')) return 'deepseek';
  if (name.includes('anthropic') || name.includes('claude')) return 'anthropic';
  if (name.includes('openai')) return 'openai';
  if (name.includes('google') || name.includes('gemini')) return 'google';
  return '';
}

export function findBasePricing(basePricing, channel, model) {
  const provider = inferProvider(channel);
  return (basePricing || []).find(item => (
    item.model === model
    && String(item.provider || '').toLowerCase() === provider
  ))
    || null;
}

export function effectivePricingForChannelModel(basePricing, channel, model) {
  const override = channel?.pricing?.models?.[model];
  if (override) return { pricing: override, source: PRICING_SOURCE.CHANNEL_OVERRIDE, label: pricingSourceLabel(PRICING_SOURCE.CHANNEL_OVERRIDE) };
  const base = findBasePricing(basePricing, channel, model);
  if (base) return { pricing: base, source: PRICING_SOURCE.BASE_DEFAULT, label: pricingSourceLabel(PRICING_SOURCE.BASE_DEFAULT) };
  return { pricing: null, source: PRICING_SOURCE.MISSING, label: pricingSourceLabel(PRICING_SOURCE.MISSING) };
}

export function convertCurrency(value, fromCurrency = 'USD', toCurrency = 'USD') {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const fromRate = USD_EXCHANGE_RATES[String(fromCurrency || 'USD').toUpperCase()];
  const toRate = USD_EXCHANGE_RATES[String(toCurrency || 'USD').toUpperCase()];
  if (!fromRate || !toRate) return n;
  return (n / fromRate) * toRate;
}

export function fmtPrice(value, currency = 'USD', displayCurrency = 'USD') {
  if (value === null || value === undefined || value === '') return '-';
  const n = convertCurrency(value, currency, displayCurrency);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function pricingValues(pricing = {}, displayCurrency = 'USD') {
  const currency = pricing.currency || 'USD';
  return [
    `input ${fmtPrice(pricing.inputTokenPrice, currency, displayCurrency)}`,
    `output ${fmtPrice(pricing.outputTokenPrice, currency, displayCurrency)}`,
    `cache ${fmtPrice(pricing.cacheReadInputTokenPrice, currency, displayCurrency)}`,
    `create ${fmtPrice(pricing.cacheCreationInputTokenPrice, currency, displayCurrency)}`,
    `call ${fmtPrice(pricing.requestPrice ?? 0, currency, displayCurrency)}`,
  ].join(' · ');
}

export function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
