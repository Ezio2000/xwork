export const PRICING_SOURCE = Object.freeze({
  CHANNEL_OVERRIDE: 'channel_override',
  BASE_DEFAULT: 'base_default',
  MISSING: 'missing',
});

const SOURCE_LABELS = {
  [PRICING_SOURCE.CHANNEL_OVERRIDE]: 'Channel Override',
  [PRICING_SOURCE.BASE_DEFAULT]: 'Base Default',
  [PRICING_SOURCE.MISSING]: 'Missing',
};

export function normalizePricingSource(source) {
  const value = String(source || '').trim();
  if (value === PRICING_SOURCE.CHANNEL_OVERRIDE || value === 'Channel Override') return PRICING_SOURCE.CHANNEL_OVERRIDE;
  if (value === PRICING_SOURCE.BASE_DEFAULT || value === 'Base Default') return PRICING_SOURCE.BASE_DEFAULT;
  return PRICING_SOURCE.MISSING;
}

export function pricingSourceLabel(source) {
  return SOURCE_LABELS[normalizePricingSource(source)] || SOURCE_LABELS[PRICING_SOURCE.MISSING];
}
