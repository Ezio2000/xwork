import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectivePricingForChannelModel,
  findBasePricing,
  fmtPrice,
  inferProvider,
  numberOrNull,
  pricingValues,
} from '../public/js/pricing-view-model.js';

describe('pricing view model', () => {
  const basePricing = [{
    id: 'deepseek-model-a',
    provider: 'deepseek',
    model: 'model-a',
    currency: 'USD',
    inputTokenPrice: 1,
    cacheReadInputTokenPrice: 0.1,
    cacheCreationInputTokenPrice: 1,
    outputTokenPrice: 2,
    requestPrice: 0,
  }];

  it('infers providers from channel URL or name', () => {
    assert.equal(inferProvider({ baseUrl: 'https://api.deepseek.com/anthropic' }), 'deepseek');
    assert.equal(inferProvider({ name: 'Claude proxy' }), 'anthropic');
    assert.equal(inferProvider({ name: 'unknown' }), '');
  });

  it('resolves channel overrides before base pricing', () => {
    const channel = {
      id: 'ch1',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      pricing: {
        models: {
          'model-a': {
            currency: 'USD',
            inputTokenPrice: 9,
            outputTokenPrice: 10,
          },
        },
      },
    };

    assert.equal(findBasePricing(basePricing, channel, 'model-a').id, 'deepseek-model-a');
    assert.deepEqual(effectivePricingForChannelModel(basePricing, channel, 'model-a'), {
      pricing: channel.pricing.models['model-a'],
      source: 'channel_override',
      label: 'Channel Override',
    });
    assert.equal(effectivePricingForChannelModel(basePricing, { ...channel, pricing: { models: {} } }, 'model-a').source, 'base_default');
    assert.equal(effectivePricingForChannelModel(basePricing, channel, 'missing-model').source, 'missing');
  });

  it('formats pricing and numeric form inputs', () => {
    assert.equal(fmtPrice(1, 'USD', 'CNY'), '7.2');
    assert.equal(fmtPrice(null), '-');
    assert.equal(pricingValues(basePricing[0], 'USD'), 'input 1 · output 2 · cache 0.1 · create 1 · call 0');
    assert.equal(numberOrNull('1.25'), 1.25);
    assert.equal(numberOrNull(''), null);
    assert.equal(numberOrNull('not-a-number'), null);
  });
});
