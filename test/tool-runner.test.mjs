import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runTool } from '../lib/tools/runner.mjs';

describe('tool runner abort support', () => {
  it('returns an error result when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await runTool(
      { id: 'toolu_abort', name: 'calculator', input: { expression: '1 + 1' } },
      { conversationId: 'test', signal: ac.signal },
    );

    assert.equal(result.isError, true);
    assert.match(String(result.output), /aborted/i);
  });
});
