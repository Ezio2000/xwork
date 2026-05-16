import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { streamChat } from '../lib/api.mjs';
import { SchemaValidationError, validateChatRequest, validateToolConfigPatch } from '../lib/schema.mjs';
import { withConversationQueue } from '../lib/storage.mjs';

describe('architecture safety contracts', () => {
  it('serializes work for the same conversation id', async () => {
    const events = [];
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const first = withConversationQueue('queue-test', async () => {
      events.push('first:start');
      await wait(20);
      events.push('first:end');
    });

    const second = withConversationQueue('queue-test', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);

    assert.deepEqual(events, [
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('rejects unsafe chat request ids and empty messages', () => {
    assert.throws(
      () => validateChatRequest({ conversationId: '../data/config', message: 'hi' }),
      SchemaValidationError,
    );
    assert.throws(
      () => validateChatRequest({ message: '   ' }),
      SchemaValidationError,
    );
  });

  it('validates tool config patches', () => {
    assert.deepEqual(validateToolConfigPatch({ enabled: 1, timeoutMs: 3000 }), {
      enabled: true,
      timeoutMs: 3000,
    });
    assert.throws(
      () => validateToolConfigPatch({ timeoutMs: -1 }),
      SchemaValidationError,
    );
  });

  it('passes AbortSignal through to provider fetch', async () => {
    const originalFetch = globalThis.fetch;
    const ac = new AbortController();
    let receivedSignal;

    globalThis.fetch = async (_url, opts) => {
      receivedSignal = opts.signal;
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                return { done: true };
              },
            };
          },
        },
      };
    };

    try {
      await streamChat(
        { baseUrl: 'https://example.test', apiKey: 'sk-test', model: 'm', maxTokens: 1, tools: [] },
        [{ role: 'user', content: 'hi' }],
        () => {},
        () => {},
        () => {},
        () => {},
        () => {},
        { signal: ac.signal },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(receivedSignal, ac.signal);
  });
});
