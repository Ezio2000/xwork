import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createToolBudgetGuard } from '../lib/tools/budget.mjs';

describe('tool budget guard', () => {
  it('limits tool calls from configured maxUses only', async () => {
    const guard = createToolBudgetGuard([
      { name: 'web_search', maxUses: 2 },
      { name: 'calculator' },
    ]);

    assert.equal(await guard.beforeToolCall({ name: 'web_search' }), null);
    assert.equal(await guard.beforeToolCall({ name: 'web_search' }), null);

    const skipped = await guard.beforeToolCall({ name: 'web_search' });
    assert.equal(skipped.skip, true);
    assert.match(skipped.output, /maximum 2 uses per agent run/);

    assert.equal(await guard.beforeToolCall({ name: 'calculator' }), null);
    assert.equal(await guard.beforeToolCall({ name: 'missing_tool' }), null);
  });
});
