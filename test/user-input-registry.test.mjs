import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createUserInputRegistry } from '../lib/user-input-registry.mjs';

describe('user input registry', () => {
  it('resolves when submitAnswer is called', async () => {
    const registry = createUserInputRegistry();
    const promise = registry.waitForAnswer({
      runId: 'run_1',
      toolCallId: 'toolu_a1',
      meta: { question: 'Pick one' },
    });
    const result = registry.submitAnswer({
      runId: 'run_1',
      toolCallId: 'toolu_a1',
      response: { status: 'answered', answer: 'yes' },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(await promise, { status: 'answered', answer: 'yes' });
  });

  it('returns error when no pending question exists', () => {
    const registry = createUserInputRegistry();
    const result = registry.submitAnswer({
      runId: 'run_1',
      toolCallId: 'toolu_missing',
      response: { status: 'answered', answer: 'yes' },
    });
    assert.equal(result.ok, false);
  });

  it('rejects when aborted', async () => {
    const registry = createUserInputRegistry();
    const controller = new AbortController();
    const promise = registry.waitForAnswer({
      runId: 'run_2',
      toolCallId: 'toolu_a2',
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(promise, /aborted/i);
  });
});
