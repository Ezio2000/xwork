import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  contentToBlocks,
  mergeSources,
  messageSources,
  messageText,
  subagentEventToBlocks,
} from '../public/js/message-blocks.js';

describe('message block protocol', () => {
  it('extracts visible assistant text from stored messages and strips search echo text', () => {
    assert.equal(messageText({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Search results for query: xwork' },
        { type: 'text', text: 'Final answer' },
      ],
    }), 'Final answer');

    assert.equal(messageText({
      role: 'assistant',
      blocks: [
        { type: 'text', content: '\n\nHello' },
        { type: 'source-cards', sources: [{ title: 'A', url: 'https://a.test' }] },
      ],
    }), 'Hello');
  });

  it('converts content arrays into stable display blocks', () => {
    const blocks = contentToBlocks([
      { type: 'text', text: 'Before' },
      {
        type: 'web_search_tool_result',
        content: [
          {
            type: 'web_search_result',
            title: 'Source A',
            url: 'https://a.test',
            page_age: '1d',
            snippet: 'A snippet',
          },
        ],
      },
      { type: 'text', text: 'After' },
      { type: 'tool_result', tool_use_id: 'uuid_1', content: '{"uuids":["u1","u2"],"count":2}' },
    ]);

    assert.deepEqual(blocks.map(block => block.type), ['text', 'source-cards', 'text', 'uuid-list']);
    assert.equal(blocks[0].content, 'Before');
    assert.equal(blocks[1].sources[0].pageAge, '1d');
    assert.equal(blocks[3].count, 2);
  });

  it('uses fallback source metadata only when content has no source blocks', () => {
    const blocks = contentToBlocks([
      { type: 'text', text: 'Answer' },
    ], [{ title: 'Fallback', url: 'https://fallback.test' }], 3);

    assert.deepEqual(blocks.map(block => block.type), ['text', 'source-cards']);
    assert.equal(blocks[1].searchCount, 3);
  });

  it('maps subagent events to display blocks without leaking transient events', () => {
    assert.deepEqual(subagentEventToBlocks({ eventType: 'subagent_delta', text: 'hidden' }), []);
    assert.deepEqual(subagentEventToBlocks({
      eventType: 'subagent_tool_result',
      renderType: 'source-cards',
      data: { sources: [{ title: 'A', url: 'https://a.test' }] },
    }), [{ type: 'source-cards', sources: [{ title: 'A', url: 'https://a.test' }], collapsed: true }]);

    const errorBlocks = subagentEventToBlocks({
      eventType: 'subagent_tool_result',
      name: 'calculator',
      isError: true,
      output: { error: 'bad expression' },
    });
    assert.equal(errorBlocks.length, 1);
    assert.match(errorBlocks[0].content, /Tool result/);
    assert.match(errorBlocks[0].content, /bad expression/);
  });

  it('deduplicates message sources by URL or source identity', () => {
    const merged = mergeSources(
      [{ title: 'A', url: 'https://a.test' }],
      [
        { title: 'A duplicate', url: 'https://a.test' },
        { title: 'B', pageAge: '1h' },
        { title: 'B', pageAge: '1h' },
      ],
    );

    assert.deepEqual(merged.map(source => source.title), ['A', 'B']);
    assert.deepEqual(messageSources({ role: 'assistant', blocks: [{ type: 'source-cards', sources: merged }] }), merged);
  });
});
