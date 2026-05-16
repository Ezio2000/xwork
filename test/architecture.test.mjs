import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { streamChat } from '../lib/api.mjs';
import { buildAuditTrace } from '../lib/audit-trace.mjs';
import { assistantMessage } from '../lib/anthropic/assistant-message.mjs';
import { appendAgentRunBlocks } from '../lib/message-rendering.mjs';
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

  it('keeps audit trace with internal tool messages on assistant messages', () => {
    const finalState = {
      reason: 'completed',
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
      text: 'done',
      content: [{ type: 'text', text: 'done' }],
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'delegate_task', input: { task: 'work' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    };
    const trace = buildAuditTrace({
      conversationId: 'conv1',
      channelId: 'ch1',
      model: 'model1',
      rootRun: { runId: 'root1', startedAt: '2026-05-16T00:00:00.000Z', durationMs: 10 },
      status: 'completed',
      finalState,
      turnStartIndex: 0,
      events: [{ type: 'tool_call', toolCallId: 'toolu_1' }],
      toolCalls: [{ toolCallId: 'toolu_1', name: 'delegate_task' }],
      toolResults: [{ toolCallId: 'toolu_1', name: 'delegate_task', isError: false }],
      agentRuns: [{ runId: 'sub1', parentRunId: 'root1', status: 'completed' }],
    });
    const message = assistantMessage({ ...finalState, trace }, 'model1');

    assert.equal(message.trace.rootRunId, 'root1');
    assert.equal(message.trace.messages[1].content[1].type, 'tool_use');
    assert.equal(message.trace.messages[2].content[0].type, 'tool_result');
    assert.equal(message.trace.toolCalls[0].toolCallId, 'toolu_1');
  });

  it('merges complete subagent metadata into existing render blocks', () => {
    const blocks = appendAgentRunBlocks(
      [{ type: 'subagent-run', runId: 'sub1', status: 'completed', text: 'done' }],
      [{
        runId: 'sub1',
        parentRunId: 'root1',
        rootRunId: 'root1',
        status: 'completed',
        label: 'Worker',
        task: 'Do work',
        durationMs: 42,
        result: { text: 'done', usage: { output_tokens: 3 } },
        events: [
          { type: 'subagent_thinking', text: 'too much' },
          { type: 'subagent_delta', text: 'before tool' },
          { type: 'subagent_tool_call', name: 'calculator' },
          { type: 'subagent_tool_result', name: 'calculator', output: 4 },
          { type: 'subagent_delta', text: 'after tool' },
        ],
      }],
    );

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].label, 'Worker');
    assert.equal(blocks[0].task, 'Do work');
    assert.equal(blocks[0].parentRunId, 'root1');
    assert.equal(blocks[0].durationMs, 42);
    assert.deepEqual(blocks[0].usage, { output_tokens: 3 });
    assert.equal(blocks[0].events.length, 2);
    assert.equal(blocks[0].events[0].type, 'subagent_tool_call');
    assert.deepEqual(blocks[0].timeline.map(item => item.kind), ['text', 'event', 'event', 'text']);
  });
});
