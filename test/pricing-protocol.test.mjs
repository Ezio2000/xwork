import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePricingSource, PRICING_SOURCE, pricingSourceLabel } from '../public/js/pricing-protocol.js';

describe('pricing protocol', () => {
  it('normalizes backend and display pricing source values', () => {
    assert.equal(normalizePricingSource('channel_override'), PRICING_SOURCE.CHANNEL_OVERRIDE);
    assert.equal(normalizePricingSource('Channel Override'), PRICING_SOURCE.CHANNEL_OVERRIDE);
    assert.equal(normalizePricingSource('base_default'), PRICING_SOURCE.BASE_DEFAULT);
    assert.equal(normalizePricingSource('Base Default'), PRICING_SOURCE.BASE_DEFAULT);
    assert.equal(normalizePricingSource('anything else'), PRICING_SOURCE.MISSING);
  });

  it('maps source values to display labels', () => {
    assert.equal(pricingSourceLabel(PRICING_SOURCE.CHANNEL_OVERRIDE), 'Channel Override');
    assert.equal(pricingSourceLabel(PRICING_SOURCE.BASE_DEFAULT), 'Base Default');
    assert.equal(pricingSourceLabel(PRICING_SOURCE.MISSING), 'Missing');
  });
});
